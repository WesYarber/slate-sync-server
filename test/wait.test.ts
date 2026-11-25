import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, MAX_WAITERS_PER_ACCOUNT } from "../src/app";

// GET /v1/changes?wait=S: hold the request until the account changes or S seconds pass.

let dir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let otherToken: string;

function call(method: string, path: string, opts: { token?: string; body?: string; base?: number; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? token}` };
  if (opts.base !== undefined) headers["x-base-version"] = String(opts.base);
  return app.fetch(new Request(`http://test${path}`, { method, headers, body: opts.body, signal: opts.signal }));
}

/** Resolves with the response and how long it took, in ms. */
async function timed(res: Promise<Response>) {
  const start = performance.now();
  const r = await res;
  return { status: r.status, body: await r.json(), ms: performance.now() - start };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slate-sync-wait-"));
  app = createApp({ dataDir: dir, host: "127.0.0.1", port: 0, maxObjectBytes: 1024, maxAccountBytes: 0 });
  token = app.store.newToken(app.store.createAccount("alice").id);
  otherToken = app.store.newToken(app.store.createAccount("other").id);
});

afterEach(() => {
  app.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("wait for changes", () => {
  test("answers at once when changes are already there", async () => {
    await call("PUT", "/v1/objects/a", { body: "x", base: 0 });
    const r = await timed(call("GET", "/v1/changes?since=0&wait=30"));
    expect(r.ms).toBeLessThan(200);
    expect(r.body.changes.map((c: any) => c.id)).toEqual(["a"]);
    expect(app.waiting()).toBe(0);
  });

  test("times out with an empty list and the same cursor", async () => {
    await call("PUT", "/v1/objects/a", { body: "x", base: 0 });
    const r = await timed(call("GET", "/v1/changes?since=1&wait=2"));
    expect(r.ms).toBeGreaterThan(1900);
    expect(r.ms).toBeLessThan(2500);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ cursor: 1, more: false, changes: [] });
    expect(app.waiting()).toBe(0);
  }, 5000);

  test("a PUT on the same account wakes it with that object", async () => {
    const waiting = timed(call("GET", "/v1/changes?since=0&wait=30"));
    await tick();
    expect(app.waiting()).toBe(1);
    await call("PUT", "/v1/objects/note1", { body: "x", base: 0 });
    const r = await waiting;
    expect(r.ms).toBeLessThan(500);
    expect(r.body).toEqual({ cursor: 1, more: false, changes: [{ id: "note1", version: 1, size: 1, deleted: false }] });
    expect(app.waiting()).toBe(0);
  });

  test("a DELETE wakes it too", async () => {
    await call("PUT", "/v1/objects/a", { body: "x", base: 0 });
    const waiting = timed(call("GET", "/v1/changes?since=1&wait=30"));
    await tick();
    await call("DELETE", "/v1/objects/a", { base: 1 });
    const r = await waiting;
    expect(r.ms).toBeLessThan(500);
    expect(r.body.changes).toEqual([{ id: "a", version: 2, size: 0, deleted: true }]);
  });

  test("a failed PUT (stale version) does not wake it", async () => {
    await call("PUT", "/v1/objects/a", { body: "x", base: 0 });
    const waiting = timed(call("GET", "/v1/changes?since=1&wait=1"));
    await tick();
    expect((await call("PUT", "/v1/objects/a", { body: "y", base: 0 })).status).toBe(409);
    const r = await waiting;
    expect(r.ms).toBeGreaterThan(900);
    expect(r.body.changes).toEqual([]);
  });

  test("a change in another account neither wakes nor reveals anything", async () => {
    const waiting = timed(call("GET", "/v1/changes?since=0&wait=1"));
    await tick();
    await call("PUT", "/v1/objects/theirs", { body: "x", base: 0, token: otherToken });
    const r = await waiting;
    expect(r.ms).toBeGreaterThan(900);
    expect(r.body).toEqual({ cursor: 0, more: false, changes: [] });
  });

  test("every waiter on the account wakes, not just one", async () => {
    const a = timed(call("GET", "/v1/changes?since=0&wait=30"));
    const b = timed(call("GET", "/v1/changes?since=0&wait=30"));
    await tick();
    expect(app.waiting()).toBe(2);
    await call("PUT", "/v1/objects/n", { body: "x", base: 0 });
    for (const r of await Promise.all([a, b])) expect(r.body.changes.map((c: any) => c.id)).toEqual(["n"]);
  });

  test("past the per-account cap the oldest is answered at once, empty", async () => {
    const held = [];
    for (let i = 0; i < MAX_WAITERS_PER_ACCOUNT; i++) held.push(timed(call("GET", "/v1/changes?since=0&wait=30")));
    await tick();
    expect(app.waiting()).toBe(MAX_WAITERS_PER_ACCOUNT);
    let oldestDone = false;
    held[0].then(() => (oldestDone = true));
    // Another account's waiter does not count against this one's cap.
    const theirs = call("GET", "/v1/changes?since=0&wait=30", { token: otherToken });
    await tick();
    expect(oldestDone).toBe(false);
    held.push(timed(call("GET", "/v1/changes?since=0&wait=30")));
    const oldest = await held[0];
    expect(oldest.body).toEqual({ cursor: 0, more: false, changes: [] });
    expect(app.waiting()).toBe(MAX_WAITERS_PER_ACCOUNT + 1);
    await call("PUT", "/v1/objects/n", { body: "x", base: 0 });
    await call("PUT", "/v1/objects/n", { body: "x", base: 0, token: otherToken });
    await Promise.all([...held, theirs]);
    expect(app.waiting()).toBe(0);
  });

  test("wait=0 takes no waiter slot, so it never pushes out a held request", async () => {
    const held = [];
    for (let i = 0; i < MAX_WAITERS_PER_ACCOUNT; i++) held.push(call("GET", "/v1/changes?since=0&wait=30"));
    await tick();
    let oldestDone = false;
    held[0].then(() => (oldestDone = true));
    await call("GET", "/v1/changes?since=0&wait=0");
    await tick();
    expect(oldestDone).toBe(false);
    await call("PUT", "/v1/objects/n", { body: "x", base: 0 });
    await Promise.all(held);
  });

  test("a client that goes away drops its waiter", async () => {
    const abort = new AbortController();
    const waiting = call("GET", "/v1/changes?since=0&wait=30", { signal: abort.signal });
    await tick();
    expect(app.waiting()).toBe(1);
    abort.abort();
    await waiting;
    expect(app.waiting()).toBe(0);
  });

  test("wait is clamped to 55 seconds and must be a whole number", async () => {
    expect((await call("GET", "/v1/changes?since=0&wait=-1")).status).toBe(400);
    expect((await call("GET", "/v1/changes?since=0&wait=1.5")).status).toBe(400);
    expect((await call("GET", "/v1/changes?since=0&wait=soon")).status).toBe(400);
    const timers: number[] = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => (timers.push(ms), real(fn, 0))) as any;
    try {
      await call("GET", "/v1/changes?since=0&wait=600");
    } finally {
      globalThis.setTimeout = real;
    }
    expect(timers).toEqual([55_000]);
  });

  test("without wait, or wait=0, an empty answer comes at once", async () => {
    for (const q of ["", "&wait=0"]) {
      const r = await timed(call("GET", `/v1/changes?since=0${q}`));
      expect(r.ms).toBeLessThan(200);
      expect(r.body).toEqual({ cursor: 0, more: false, changes: [] });
    }
    expect(app.waiting()).toBe(0);
  });

  test("a bad token is refused at once, never held", async () => {
    const r = await timed(call("GET", "/v1/changes?since=0&wait=30", { token: "slate_nope" }));
    expect(r.status).toBe(401);
    expect(r.ms).toBeLessThan(200);
    expect(app.waiting()).toBe(0);
  });
});

describe("wait through a real Bun server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeEach(() => {
    // An idle timeout far shorter than the hold, so only the per-request override can save it.
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1, fetch: app.fetch });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterEach(() => server.stop(true));

  const auth = () => ({ authorization: `Bearer ${token}` });

  test("a hold longer than the idle timeout is not cut short", async () => {
    const start = performance.now();
    // Bun checks idle sockets every ~4 s, so idleTimeout 1 cuts a bare hold at about 4 s.
    const res = await fetch(`${base}/v1/changes?since=0&wait=6`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cursor: 0, more: false, changes: [] });
    expect(performance.now() - start).toBeGreaterThan(5900);
  }, 10000);

  test("a held request does not block others, and a PUT over HTTP wakes it", async () => {
    const waiting = fetch(`${base}/v1/changes?since=0&wait=30`, { headers: auth() });
    await tick(100);
    const start = performance.now();
    const put = await fetch(`${base}/v1/objects/n`, { method: "PUT", headers: { ...auth(), "x-base-version": "0" }, body: "x" });
    expect(put.status).toBe(200);
    const body = await (await waiting).json();
    expect(performance.now() - start).toBeLessThan(500);
    expect(body.changes.map((c: any) => c.id)).toEqual(["n"]);
  });

  test("a client disconnecting drops its waiter", async () => {
    const abort = new AbortController();
    const waiting = fetch(`${base}/v1/changes?since=0&wait=30`, { headers: auth(), signal: abort.signal }).catch(() => null);
    await tick(100);
    expect(app.waiting()).toBe(1);
    abort.abort();
    await waiting;
    for (let i = 0; i < 20 && app.waiting() > 0; i++) await tick();
    expect(app.waiting()).toBe(0);
  });
});
