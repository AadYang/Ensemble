import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { DATA_DIR, PORT } from "./config.js";
import { INVITE_CODE } from "./config.js";
import { Store } from "./store.js";

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(join(DATA_DIR, "postoffice.db"), join(DATA_DIR, "files"), INVITE_CODE);
store.sweepExpiredFiles();
setInterval(() => store.sweepExpiredFiles(), 60 * 60 * 1000).unref();

const HOST = process.env.HOST ?? "127.0.0.1";
const app = await createApp(store);
await app.listen({ port: PORT, host: HOST });
console.log(`ensemble-postoffice listening on ${HOST}:${PORT}`);
