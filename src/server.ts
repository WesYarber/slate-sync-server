import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // A little room over the object limit for the request itself.
  maxRequestBodySize: config.maxObjectBytes + 64 * 1024,
  fetch: app.fetch,
});

console.log(`slate-sync-server listening on http://${server.hostname}:${server.port} (data in ${config.dataDir})`);

function stop() {
  server.stop();
  app.store.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
