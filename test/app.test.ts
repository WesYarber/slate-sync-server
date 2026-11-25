import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { Config } from "../src/config";

let dir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let config: Config;

function call(method: string, path: string, opts: { token?: string | null; body?: Uint8Array | string; base?: number } = {}) {
  const headers: Record<string, string> = {};
  const t = opts.token === undefined ? token : opts.token;
  if (t) headers.authorization = `Bearer ${t}`;
  if (opts.base !== undefined) headers["x-base-version"] = String(opts.base);
  return app.fetch(new Request(`http://test${path}`, { method, headers, body: opts.body }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slate-sync-test-"));
  config = { dataDir: dir, host: "127.0.0.1", port: 0, maxObjectBytes: 1024, maxAccountBytes: 0 };
  app = createApp(config);
  const account = app.store.createAccount("alice");
  token = app.store.newToken(account.id);
});

afterEach(() => {
  app.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  test("health needs no token", async () => {
    const res = await call("GET", "/v1/health", { token: null });
    expect(res.status).toBe(200);
  });

  test("missing or wrong token is 401", async () => {
    expect((await call("GET", "/v1/changes", { token: null })).status).toBe(401);
    expect((await call("GET", "/v1/changes", { token: "slate_nope" })).status).toBe(401);
  });

  test("tokens are stored hashed", () => {
    const rows = app.store.db.query<{ hash: string }, []>("SELECT hash FROM tokens").all();
    expect(rows.length).toBe(1);
    expect(rows[0].hash).not.toBe(token);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("revoked tokens stop working", async () => {
    app.store.revokeTokens(app.store.account("alice")!.id);
    expect((await call("GET", "/v1/account")).status).toBe(401);
  });

  test("accounts can't see each other's objects", async () => {
    await call("PUT", "/v1/objects/abc", { body: "mine", base: 0 });
    const other = app.store.createAccount("other");
    const otherToken = app.store.newToken(other.id);
    expect((await call("GET", "/v1/objects/abc", { token: otherToken })).status).toBe(404);
    const changes = await (await call("GET", "/v1/changes?since=0", { token: otherToken })).json();
    expect(changes.changes).toEqual([]);
  });
});

describe("objects", () => {
  test("put, get, update with versions", async () => {
    let res = await call("PUT", "/v1/objects/abc", { body: "one", base: 0 });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(1);

    res = await call("GET", "/v1/objects/abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-version")).toBe("1");
    expect(await res.text()).toBe("one");

    res = await call("PUT", "/v1/objects/abc", { body: "two", base: 1 });
    expect((await res.json()).version).toBe(2);
    expect(await (await call("GET", "/v1/objects/abc")).text()).toBe("two");
  });

  test("stale version is 409 with the current one", async () => {
    await call("PUT", "/v1/objects/abc", { body: "one", base: 0 });
    await call("PUT", "/v1/objects/abc", { body: "two", base: 1 });
    const res = await call("PUT", "/v1/objects/abc", { body: "late", base: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).current.version).toBe(2);
    // Creating over an existing object is stale too.
    expect((await call("PUT", "/v1/objects/abc", { body: "new", base: 0 })).status).toBe(409);
    expect(await (await call("GET", "/v1/objects/abc")).text()).toBe("two");
  });

  test("put without X-Base-Version is refused", async () => {
    expect((await call("PUT", "/v1/objects/abc", { body: "one" })).status).toBe(428);
  });

  test("size limit is 413", async () => {
    const res = await call("PUT", "/v1/objects/big", { body: new Uint8Array(1025), base: 0 });
    expect(res.status).toBe(413);
    expect((await call("GET", "/v1/objects/big")).status).toBe(404);
  });

  test("account limit is 507", async () => {
    app.store.close();
    app = createApp({ ...config, maxAccountBytes: 10 });
    expect((await call("PUT", "/v1/objects/a", { body: "12345678", base: 0 })).status).toBe(200);
    expect((await call("PUT", "/v1/objects/b", { body: "12345", base: 0 })).status).toBe(507);
    // Replacing an object counts only the difference.
    expect((await call("PUT", "/v1/objects/a", { body: "1234567890", base: 1 })).status).toBe(200);
  });

  test("bad ids are refused", async () => {
    expect((await call("PUT", "/v1/objects/..%2Fetc", { body: "x", base: 0 })).status).toBe(400);
    expect((await call("GET", "/v1/objects/a.b")).status).toBe(400);
  });

  test("delete leaves a tombstone, and needs the current version", async () => {
    await call("PUT", "/v1/objects/abc", { body: "one", base: 0 });
    expect((await call("DELETE", "/v1/objects/abc", { base: 0 })).status).toBe(409);
    const res = await call("DELETE", "/v1/objects/abc", { base: 1 });
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info).toMatchObject({ deleted: true, version: 2 });
    const get = await call("GET", "/v1/objects/abc");
    expect(get.status).toBe(404);
    expect((await get.json()).deleted).toBe(true);
    // Deleting again is fine.
    expect((await call("DELETE", "/v1/objects/abc", { base: 2 })).status).toBe(200);
    // The blob file is gone.
    expect(readdirSync(join(dir, "blobs", "1", "ab"))).toEqual([]);
  });

  test("a deleted object can be made again", async () => {
    await call("PUT", "/v1/objects/abc", { body: "one", base: 0 });
    await call("DELETE", "/v1/objects/abc", { base: 1 });
    // From a device that never saw it, or one that saw the delete.
    let res = await call("PUT", "/v1/objects/abc", { body: "again", base: 0 });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(3);
    await call("DELETE", "/v1/objects/abc", { base: 3 });
    res = await call("PUT", "/v1/objects/abc", { body: "third", base: 4 });
    expect(res.status).toBe(200);
  });

  test("an edit based on a version older than a delete is 409", async () => {
    await call("PUT", "/v1/objects/abc", { body: "one", base: 0 });
    await call("DELETE", "/v1/objects/abc", { base: 1 });
    const res = await call("PUT", "/v1/objects/abc", { body: "edit", base: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).current).toMatchObject({ deleted: true, version: 2 });
  });

  test("stores bytes as given", async () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 128]);
    await call("PUT", "/v1/objects/bin", { body: bytes, base: 0 });
    const got = new Uint8Array(await (await call("GET", "/v1/objects/bin")).arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(bytes));
    const file = join(dir, "blobs", "1", "bi", "bin");
    expect(statSync(file).size).toBe(5);
    expect(Array.from(readFileSync(file))).toEqual(Array.from(bytes));
  });
});

describe("changes", () => {
  test("lists what changed after a cursor, latest state only", async () => {
    let res = await (await call("GET", "/v1/changes?since=0")).json();
    expect(res).toEqual({ cursor: 0, more: false, changes: [] });

    await call("PUT", "/v1/objects/a", { body: "1", base: 0 });
    await call("PUT", "/v1/objects/b", { body: "2", base: 0 });
    res = await (await call("GET", "/v1/changes?since=0")).json();
    expect(res.changes.map((c: any) => c.id)).toEqual(["a", "b"]);
    const cursor = res.cursor;

    await call("PUT", "/v1/objects/a", { body: "11", base: 1 });
    await call("DELETE", "/v1/objects/b", { base: 1 });
    res = await (await call("GET", `/v1/changes?since=${cursor}`)).json();
    expect(res.changes).toEqual([
      { id: "a", version: 2, size: 2, deleted: false },
      { id: "b", version: 2, size: 0, deleted: true },
    ]);
    const after = await (await call("GET", `/v1/changes?since=${res.cursor}`)).json();
    expect(after.changes).toEqual([]);
    expect(after.cursor).toBe(res.cursor);
  });

  test("pages with limit", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) await call("PUT", `/v1/objects/${id}`, { body: id, base: 0 });
    const seen: string[] = [];
    let since = 0;
    for (;;) {
      const res = await (await call("GET", `/v1/changes?since=${since}&limit=2`)).json();
      seen.push(...res.changes.map((c: any) => c.id));
      since = res.cursor;
      if (!res.more) break;
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("account reports usage and limits", async () => {
    await call("PUT", "/v1/objects/a", { body: "1234", base: 0 });
    const res = await (await call("GET", "/v1/account")).json();
    expect(res).toEqual({ name: "alice", objects: 1, bytes: 4, maxObjectBytes: 1024, maxAccountBytes: 0, wait: true });
  });
});
