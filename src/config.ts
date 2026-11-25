import { resolve } from "node:path";

export interface Config {
  /** Where the database and blobs live. */
  dataDir: string;
  host: string;
  port: number;
  /** Largest single object, in bytes. */
  maxObjectBytes: number;
  /** Most an account may store in all, in bytes (0: no limit). */
  maxAccountBytes: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return value;
}

export function loadConfig(): Config {
  return {
    dataDir: resolve(process.env.DATA_DIR || "./data"),
    host: process.env.HOST || "127.0.0.1",
    port: int("PORT", 8787),
    maxObjectBytes: int("MAX_OBJECT_BYTES", 100 * 1024 * 1024),
    maxAccountBytes: int("MAX_ACCOUNT_BYTES", 0),
  };
}
