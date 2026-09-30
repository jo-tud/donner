// Shared test helpers.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateCorpus } from "./fixtures/corpus.js";
import { startHarness } from "./fixtures/harness.js";
import { DEFAULTS } from "../src/config.js";
import { openDb } from "../src/db.js";
import { BridgeClient } from "../src/bridge.js";
import { sync } from "../src/sync.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = join(ROOT, "bin", "donner.js");

export function tempDir(prefix = "donner-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(bridge, overrides = {}) {
  const cfg = structuredClone(DEFAULTS);
  cfg.bridge = { ...bridge };
  cfg.index.maxMessageBytes = 200 * 1024;
  cfg.index.concurrency = 4;
  cfg.mcp.autoSync = false;
  Object.assign(cfg.index, overrides.index || {});
  if (overrides.embeddings) Object.assign(cfg.embeddings, overrides.embeddings);
  return cfg;
}

/** Start the harness and build an index. Call `cleanup()` in `after`. */
export async function setupIndexed({ count = 400, seed = 42, authToken = null, sync: doSync = true, index = {}, separateProcess = false } = {}) {
  const corpus = separateProcess ? { messages: { length: count }, accounts: [], facts: {} } : generateCorpus({ count, seed });
  const h = await startHarness({ corpus, authToken, separateProcess: separateProcess ? { count, seed } : null });
  const dir = tempDir();
  const dbPath = join(dir, "index.sqlite");
  const cfg = testConfig(h.bridge, { index });
  const db = openDb(dbPath);
  const bridge = new BridgeClient(h.bridge);
  let stats = null;
  if (doSync) stats = await sync({ db, bridge, cfg });
  const env = {
    ...process.env,
    TZ: "UTC",
    NO_COLOR: "1",
    DONNER_DB: dbPath,
    DONNER_CONFIG_DIR: join(dir, "config"),
    DONNER_DATA_DIR: join(dir, "data"),
    DONNER_BRIDGE_HOST: "127.0.0.1",
    DONNER_BRIDGE_PORT: String(h.bridge.port),
    TB_AUTH_TOKEN: authToken || "",
  };
  if (!authToken) delete env.TB_AUTH_TOKEN;
  delete env.DONNER_AUTH_TOKEN;
  return {
    corpus,
    h,
    dir,
    dbPath,
    cfg,
    db,
    bridge,
    stats,
    env,
    resync: (opts = {}) => sync({ db, bridge, cfg, ...opts }),
    async cleanup() {
      try {
        db.close();
      } catch {
        // closed
      }
      await h.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run the CLI; resolves {code, stdout, stderr, json}. */
export function runCli(args, { env = process.env, input = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: donner ${args.join(" ")}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        try {
          json = JSON.parse(stderr);
        } catch {
          // not JSON
        }
      }
      resolve({ code, stdout, stderr, json });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function midsOf(db, ids) {
  return ids.map((id) => db.prepare("SELECT mid FROM messages WHERE id = ?").get(id)?.mid);
}

export function idByMid(db, mid) {
  return db.prepare("SELECT id FROM messages WHERE mid = ? ORDER BY id LIMIT 1").get(mid)?.id;
}
