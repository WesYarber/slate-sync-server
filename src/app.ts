import type { Config } from "./config";
import { Conflict, ID_PATTERN, QuotaExceeded, Store, type Account, type ObjectInfo } from "./store";

/**
 * The HTTP API (all under /v1, all but /v1/health need
 * `Authorization: Bearer <token>`):
 *
 *   GET    /v1/health                 {ok: true}
 *   GET    /v1/account                name, usage and limits
 *   GET    /v1/changes?since=N        objects changed after cursor N
 *          ...&wait=S                 if none yet, hold up to S seconds (1-55) for one
 *   GET    /v1/objects/:id            the blob; X-Version header
 *   PUT    /v1/objects/:id            body: the blob; X-Base-Version: the version it replaces (0: new)
 *   DELETE /v1/objects/:id            X-Base-Version: the version it deletes
 *
 * A stale X-Base-Version gets 409 with the current state, so the client
 * can merge and try again.
 */
/** Longest a `wait` may hold, kept under the Cloudflare tunnel's idle timeout. */
export const MAX_WAIT_SECONDS = 55;
/** Most requests one account may have waiting; past this the oldest is answered at once. */
export const MAX_WAITERS_PER_ACCOUNT = 16;

/** Just enough of Bun's Server to give a held request a longer idle timeout. */
export interface Timeouts {
  timeout(req: Request, seconds: number): void;
}

export function createApp(config: Config, store = new Store(config.dataDir)) {
  // Requests waiting on /v1/changes, per account, oldest first. Calling one
  // wakes it; it removes itself however it ends (change, timeout, disconnect).
  const waiters = new Map<number, Set<() => void>>();

  function wake(accountID: number) {
    const set = waiters.get(accountID);
    if (set) for (const done of [...set]) done();
  }

  function waitForChange(accountID: number, seconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = waiters.get(accountID);
      if (!set) waiters.set(accountID, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        set!.delete(done);
        if (set!.size === 0 && waiters.get(accountID) === set) waiters.delete(accountID);
        resolve();
      };
      const timer = setTimeout(done, seconds * 1000);
      signal.addEventListener("abort", done);
      set.add(done);
      if (set.size > MAX_WAITERS_PER_ACCOUNT) set.values().next().value!();
      if (signal.aborted) done();
    });
  }

  async function handle(req: Request, server?: Timeouts): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/v1/health" && req.method === "GET") return json({ ok: true });
    if (!path.startsWith("/v1/")) return error(404, "not found");

    const account = authenticate(req);
    if (!account) return error(401, "missing or unknown token");

    if (path === "/v1/account" && req.method === "GET") {
      const usage = store.usage(account.id);
      return json({
        name: account.name,
        objects: usage.objects,
        bytes: usage.bytes,
        maxObjectBytes: config.maxObjectBytes,
        maxAccountBytes: config.maxAccountBytes,
        wait: true,
      });
    }

    if (path === "/v1/changes" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "1000"), 1), 5000);
      const waitRaw = Number(url.searchParams.get("wait") ?? "0");
      if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit)) return error(400, "bad since or limit");
      if (!Number.isInteger(waitRaw) || waitRaw < 0) return error(400, "bad wait");
      let result = store.changes(account.id, since, limit);
      if (waitRaw > 0 && result.changes.length === 0) {
        const wait = Math.min(waitRaw, MAX_WAIT_SECONDS);
        // Bun's idle timeout (10 s by default) would otherwise cut the hold short.
        server?.timeout(req, wait + 10);
        await waitForChange(account.id, wait, req.signal);
        result = store.changes(account.id, since, limit);
      }
      return json({ cursor: result.cursor, more: result.more, changes: result.changes.map(publicInfo) });
    }

    const match = path.match(/^\/v1\/objects\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (!ID_PATTERN.test(id)) return error(400, "bad object id");
      switch (req.method) {
        case "GET":
        case "HEAD":
          return getObject(account, id, req.method === "HEAD");
        case "PUT":
          return putObject(account, id, req);
        case "DELETE":
          return deleteObject(account, id, req);
      }
      return error(405, "method not allowed");
    }
    return error(404, "not found");
  }

  function authenticate(req: Request): Account | null {
    const header = req.headers.get("authorization") ?? "";
    const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
    return token ? store.authenticate(token) : null;
  }

  function getObject(account: Account, id: string, headOnly: boolean): Response {
    const { info, data } = store.read(account.id, id);
    if (!info || !data) {
      return json({ error: "not found", ...(info ? publicInfo(info) : {}) }, 404, info ? versionHeader(info) : {});
    }
    return new Response(headOnly ? null : data, {
      headers: { "content-type": "application/octet-stream", "content-length": String(data.byteLength), ...versionHeader(info) },
    });
  }

  async function putObject(account: Account, id: string, req: Request): Promise<Response> {
    const base = baseVersion(req);
    if (base === null) return error(428, "X-Base-Version header required");
    const declared = Number(req.headers.get("content-length") ?? "NaN");
    if (declared > config.maxObjectBytes) return error(413, `object larger than ${config.maxObjectBytes} bytes`);
    const data = new Uint8Array(await req.arrayBuffer());
    if (data.byteLength > config.maxObjectBytes) return error(413, `object larger than ${config.maxObjectBytes} bytes`);
    try {
      const info = store.put(account.id, id, base, data, config.maxAccountBytes);
      wake(account.id);
      return json(publicInfo(info), 200, versionHeader(info));
    } catch (e) {
      if (e instanceof Conflict) return conflict(e);
      if (e instanceof QuotaExceeded) return error(507, "account storage limit reached");
      throw e;
    }
  }

  function deleteObject(account: Account, id: string, req: Request): Response {
    const base = baseVersion(req);
    if (base === null) return error(428, "X-Base-Version header required");
    try {
      const info = store.remove(account.id, id, base);
      wake(account.id);
      return json(publicInfo(info), 200, versionHeader(info));
    } catch (e) {
      if (e instanceof Conflict) return conflict(e);
      throw e;
    }
  }

  return {
    store,
    /** How many requests are waiting, across every account (for tests). */
    waiting: () => [...waiters.values()].reduce((n, set) => n + set.size, 0),
    async fetch(req: Request, server?: Timeouts): Promise<Response> {
      try {
        return await handle(req, server);
      } catch (e) {
        console.error(e);
        return error(500, "server error");
      }
    },
  };
}

function baseVersion(req: Request): number | null {
  const raw = req.headers.get("x-base-version");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function publicInfo(info: ObjectInfo) {
  return { id: info.id, version: info.version, size: info.size, deleted: info.deleted };
}

function versionHeader(info: ObjectInfo): Record<string, string> {
  return { "x-version": String(info.version) };
}

function conflict(e: Conflict): Response {
  const current = e.current ? publicInfo(e.current) : { version: 0, deleted: true };
  return json({ error: "stale version", current }, 409, { "x-version": String(current.version) });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}
