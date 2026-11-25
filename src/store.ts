import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Accounts, tokens and object records in SQLite; object contents as files
 * under `blobs/`. The server only ever sees opaque ids and ciphertext.
 *
 * Every write to an account bumps that account's `seq`, and the object
 * remembers the seq of its latest change, so "what changed since N" is a
 * single indexed query. Deleted objects stay as tombstones (no blob) so
 * other devices learn about the delete.
 */

export interface ObjectInfo {
  id: string;
  version: number;
  size: number;
  deleted: boolean;
  seq: number;
  updatedAt: number;
}

export interface Account {
  id: number;
  name: string;
  createdAt: number;
}

export class Conflict extends Error {
  constructor(public current: ObjectInfo | null) {
    super("stale version");
  }
}

export class QuotaExceeded extends Error {}

/** Object ids: what the client chose, kept to a safe file name. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Store {
  readonly db: Database;
  private blobDir: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, "slate-sync.sqlite"), { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS objects (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        size INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS objects_by_seq ON objects (account_id, seq);
    `);
  }

  close() {
    this.db.close();
  }

  // Accounts and tokens

  createAccount(name: string): Account {
    const now = Date.now();
    const row = this.db
      .query<{ id: number }, [string, number]>("INSERT INTO accounts (name, created_at) VALUES (?, ?) RETURNING id")
      .get(name, now)!;
    return { id: row.id, name, createdAt: now };
  }

  account(name: string): Account | null {
    const row = this.db
      .query<{ id: number; name: string; created_at: number }, [string]>(
        "SELECT id, name, created_at FROM accounts WHERE name = ?",
      )
      .get(name);
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
  }

  accounts(): (Account & { tokens: number; objects: number; bytes: number })[] {
    return this.db
      .query<any, []>(
        `SELECT a.id, a.name, a.created_at AS createdAt,
           (SELECT COUNT(*) FROM tokens t WHERE t.account_id = a.id) AS tokens,
           (SELECT COUNT(*) FROM objects o WHERE o.account_id = a.id AND o.deleted = 0) AS objects,
           (SELECT COALESCE(SUM(size), 0) FROM objects o WHERE o.account_id = a.id AND o.deleted = 0) AS bytes
         FROM accounts a ORDER BY a.name`,
      )
      .all();
  }

  /** A new token for the account; only its hash is kept. */
  newToken(accountID: number, label = ""): string {
    const token = "slate_" + randomBytes(32).toString("base64url");
    this.db
      .query("INSERT INTO tokens (hash, account_id, label, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), accountID, label, Date.now());
    return token;
  }

  revokeTokens(accountID: number): number {
    return this.db.query("DELETE FROM tokens WHERE account_id = ?").run(accountID).changes;
  }

  deleteAccount(accountID: number) {
    this.db.query("DELETE FROM accounts WHERE id = ?").run(accountID);
    rmSync(join(this.blobDir, String(accountID)), { recursive: true, force: true });
  }

  /** The account a token belongs to, or null. */
  authenticate(token: string): Account | null {
    const row = this.db
      .query<{ id: number; name: string; created_at: number }, [string]>(
        `SELECT a.id, a.name, a.created_at FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE t.hash = ?`,
      )
      .get(hashToken(token));
    if (!row) return null;
    this.db.query("UPDATE tokens SET last_used_at = ? WHERE hash = ?").run(Date.now(), hashToken(token));
    return { id: row.id, name: row.name, createdAt: row.created_at };
  }

  // Objects

  private blobPath(accountID: number, id: string): string {
    return join(this.blobDir, String(accountID), id.slice(0, 2), id);
  }

  info(accountID: number, id: string): ObjectInfo | null {
    const row = this.db
      .query<any, [number, string]>(
        "SELECT id, version, size, deleted, seq, updated_at FROM objects WHERE account_id = ? AND id = ?",
      )
      .get(accountID, id);
    return row ? toInfo(row) : null;
  }

  usage(accountID: number): { objects: number; bytes: number } {
    return this.db
      .query<{ objects: number; bytes: number }, [number]>(
        "SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM objects WHERE account_id = ? AND deleted = 0",
      )
      .get(accountID)!;
  }

  changes(accountID: number, since: number, limit: number): { changes: ObjectInfo[]; cursor: number; more: boolean } {
    const rows = this.db
      .query<any, [number, number, number]>(
        `SELECT id, version, size, deleted, seq, updated_at FROM objects
         WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(accountID, since, limit + 1);
    const more = rows.length > limit;
    const changes = rows.slice(0, limit).map(toInfo);
    const cursor = changes.length ? changes[changes.length - 1].seq : Math.max(since, 0);
    return { changes, cursor: more ? cursor : Math.max(cursor, this.seq(accountID)), more };
  }

  private seq(accountID: number): number {
    return this.db.query<{ seq: number }, [number]>("SELECT seq FROM accounts WHERE id = ?").get(accountID)?.seq ?? 0;
  }

  private nextSeq(accountID: number): number {
    return this.db
      .query<{ seq: number }, [number]>("UPDATE accounts SET seq = seq + 1 WHERE id = ? RETURNING seq")
      .get(accountID)!.seq;
  }

  read(accountID: number, id: string): { info: ObjectInfo; data: Uint8Array } | { info: ObjectInfo | null; data: null } {
    const info = this.info(accountID, id);
    if (!info || info.deleted) return { info, data: null };
    const path = this.blobPath(accountID, id);
    if (!existsSync(path)) return { info: null, data: null };
    return { info, data: readFileSync(path) };
  }

  /**
   * Stores a new version if `baseVersion` is the current one (0 for an
   * object that doesn't exist or was deleted). Runs synchronously, so two
   * requests can't interleave between the check and the write.
   */
  put(accountID: number, id: string, baseVersion: number, data: Uint8Array, maxAccountBytes: number): ObjectInfo {
    const current = this.info(accountID, id);
    const live = current && !current.deleted ? current : null;
    const expected = live ? live.version : 0;
    if (baseVersion !== expected && !(current?.deleted && baseVersion === current.version)) {
      throw new Conflict(current);
    }
    if (maxAccountBytes > 0) {
      const used = this.usage(accountID).bytes - (live?.size ?? 0);
      if (used + data.byteLength > maxAccountBytes) throw new QuotaExceeded("account is full");
    }
    const path = this.blobPath(accountID, id);
    mkdirSync(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, data);
    const version = (current?.version ?? 0) + 1;
    const now = Date.now();
    try {
      this.db.transaction(() => {
        const seq = this.nextSeq(accountID);
        this.db
          .query(
            `INSERT INTO objects (account_id, id, version, size, deleted, seq, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT (account_id, id) DO UPDATE SET version = excluded.version, size = excluded.size,
               deleted = 0, seq = excluded.seq, updated_at = excluded.updated_at`,
          )
          .run(accountID, id, version, data.byteLength, seq, now);
      })();
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return this.info(accountID, id)!;
  }

  /** Leaves a tombstone so other devices see the delete. */
  remove(accountID: number, id: string, baseVersion: number): ObjectInfo {
    const current = this.info(accountID, id);
    if (!current || current.deleted) {
      if (current && baseVersion !== current.version && baseVersion !== 0) throw new Conflict(current);
      return current ?? { id, version: 0, size: 0, deleted: true, seq: 0, updatedAt: 0 };
    }
    if (baseVersion !== current.version) throw new Conflict(current);
    this.db.transaction(() => {
      const seq = this.nextSeq(accountID);
      this.db
        .query("UPDATE objects SET version = version + 1, size = 0, deleted = 1, seq = ?, updated_at = ? WHERE account_id = ? AND id = ?")
        .run(seq, Date.now(), accountID, id);
    })();
    rmSync(this.blobPath(accountID, id), { force: true });
    return this.info(accountID, id)!;
  }
}

function toInfo(row: any): ObjectInfo {
  return {
    id: row.id,
    version: row.version,
    size: row.size,
    deleted: row.deleted === 1,
    seq: row.seq,
    updatedAt: row.updated_at,
  };
}
