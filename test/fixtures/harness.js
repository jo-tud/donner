// Test harness: runs the real thunderbird-cli bridge (child process) and the real
// thunderbird-cli extension background script (in a vm) on top of FakeThunderbird.
//
//   donner ──HTTP──▶ bridge.js (real) ──WS──▶ background.js (real) ──▶ FakeThunderbird

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { FakeThunderbird } from "./fake-thunderbird.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(here, "..", "vendor", "thunderbird-cli");

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startBridge({ httpPort, wsPort, authToken }) {
  const env = { ...process.env };
  delete env.TB_AUTH_TOKEN;
  if (authToken) env.TB_AUTH_TOKEN = authToken;
  const child = spawn(process.execPath, [join(VENDOR, "bridge.js"), "--port", String(httpPort), "--ws-port", String(wsPort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start:\n" + log)), 10000);
    child.stdout.on("data", (d) => {
      log += d;
      if (log.includes("Waiting for Thunderbird")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (d) => (log += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited with ${code}:\n${log}`));
    });
  });
  child.log = () => log;
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return child;
}

export class Extension {
  constructor(tb, wsPort) {
    this.tb = tb;
    this.wsPort = wsPort;
    this.timers = new Set();
    this.sockets = new Set();
    this.load();
  }

  load() {
    const timers = this.timers;
    const sockets = this.sockets;
    const self = this;
    class TrackedWebSocket extends WebSocket {
      constructor(...args) {
        super(...args);
        sockets.add(this);
        this.on("close", () => sockets.delete(this));
      }
    }
    const src =
      readFileSync(join(VENDOR, "thread-utils.js"), "utf8") +
      "\n" +
      readFileSync(join(VENDOR, "background.js"), "utf8").replace("ws://127.0.0.1:7701", `ws://127.0.0.1:${this.wsPort}`);
    const context = vm.createContext({
      messenger: this.tb.messenger,
      WebSocket: TrackedWebSocket,
      console: { log() {}, error() {}, warn() {} },
      setTimeout: (fn, ms) => {
        if (self.stopped) return 0;
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
        return t;
      },
      clearTimeout: (t) => {
        timers.delete(t);
        clearTimeout(t);
      },
      btoa,
      atob,
      TextEncoder,
      TextDecoder,
      URL,
    });
    vm.runInContext(src, context, { filename: "background.js" });
    this.context = context;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.sockets) s.terminate();
    this.sockets.clear();
  }
}

/**
 * Start bridge + extension + fake Thunderbird.
 * @returns {Promise<{tb: FakeThunderbird, bridge: {host, port, authToken}, stop(), disconnect(), reconnect(), restartThunderbird()}>}
 */
export async function startHarness({ corpus, authToken = null, separateProcess = null } = {}) {
  const httpPort = await freePort();
  const wsPort = await freePort();
  const child = await startBridge({ httpPort, wsPort, authToken });
  if (separateProcess) return startSeparate({ child, httpPort, wsPort, authToken, ...separateProcess });
  const tb = new FakeThunderbird(corpus);
  let ext = new Extension(tb, wsPort);
  const bridge = { host: "127.0.0.1", port: httpPort, authToken, timeoutMs: 30000 };

  const waitConnected = async (want = "connected") => {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    for (let i = 0; i < 200; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${httpPort}/bridge/status`, { headers });
        const j = await r.json();
        if (j.extension === want) return;
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`extension did not become ${want}`);
  };
  await waitConnected();

  return {
    tb,
    bridge,
    bridgeLog: () => child.log(),
    bridgeExitCode: () => child.exitCode,
    async stop() {
      ext.stop();
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    },
    /** Thunderbird closed: the extension disconnects from the bridge. */
    async disconnect() {
      ext.stop();
      await waitConnected("disconnected");
    },
    async reconnect() {
      ext = new Extension(tb, wsPort);
      await waitConnected();
    },
    /** Thunderbird restarted: new session, new message ids. */
    async restartThunderbird() {
      ext.stop();
      await waitConnected("disconnected");
      tb.restart();
      ext = new Extension(tb, wsPort);
      await waitConnected();
    },
  };
}

/**
 * Thunderbird (fake + real extension code) in its own process, like in reality: donner's
 * event loop cannot delay the extension's WebSocket heartbeat. Used by the benchmark.
 */
async function startSeparate({ child, httpPort, wsPort, authToken, count, seed }) {
  const tbProc = spawn(process.execPath, ["--max-old-space-size=6000", join(here, "tb-process.js"), String(wsPort), String(count), String(seed)], { stdio: ["ignore", "inherit", "inherit"] });
  const bridge = { host: "127.0.0.1", port: httpPort, authToken, timeoutMs: 120000 };
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  for (let i = 0; i < 2400; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${httpPort}/bridge/status`, { headers });
      if ((await r.json()).extension === "connected") break;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    tb: null,
    bridge,
    bridgeLog: () => child.log(),
    async stop() {
      tbProc.kill();
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    },
  };
}
