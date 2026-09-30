// Parse untrusted messages in worker threads with a hard time and memory limit.
//
// Parsing (MIME, HTML, PDF, Office) is the code that touches attacker-controlled bytes. A
// pathological mail must never stall `donner sync`, `watch` or the MCP server's
// auto-sync: each parse gets its own deadline, and a worker that exceeds it or runs out of
// memory is terminated and replaced; the message is recorded as an error and skipped.

import { Worker } from "node:worker_threads";
import { DonnerError } from "./errors.js";

const WORKER_URL = new URL("./parse-worker.js", import.meta.url);

export class ParsePool {
  constructor({ size = 2, timeoutMs = 60000, maxMemoryMb = 512 } = {}) {
    this.size = Math.max(1, size);
    this.timeoutMs = timeoutMs;
    this.maxMemoryMb = maxMemoryMb;
    this.idle = [];
    this.all = new Set();
    this.waiting = [];
    this.nextId = 1;
    this.closed = false;
  }

  spawn() {
    const w = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: this.maxMemoryMb, maxYoungGenerationSizeMb: 64 } });
    w.unref();
    this.all.add(w);
    return w;
  }

  acquire() {
    if (this.idle.length) return Promise.resolve(this.idle.pop());
    if (this.all.size < this.size) return Promise.resolve(this.spawn());
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(w) {
    if (this.closed) {
      w.terminate();
      return;
    }
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  discard(w) {
    this.all.delete(w);
    w.terminate().catch(() => {});
    const next = this.waiting.shift();
    if (next && !this.closed) next(this.spawn());
  }

  /** Parse a raw message (Buffer) → parsed document (see mime.js). */
  async parse(raw, opts) {
    if (this.closed) throw new DonnerError("INTERNAL", "parse pool closed");
    const w = await this.acquire();
    if (!w) throw new DonnerError("INTERNAL", "parse pool closed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value, keep) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.off("message", onMessage);
        w.off("error", onError);
        w.off("exit", onExit);
        if (keep) this.release(w);
        else this.discard(w);
        fn(value);
      };
      const onMessage = (msg) => {
        if (msg?.id !== id) return;
        if (msg.error) done(reject, new DonnerError("PARSE_ERROR", msg.error), true);
        else done(resolve, msg.result, true);
      };
      const onError = (err) => {
        const oom = /out of memory|ERR_WORKER_OUT_OF_MEMORY/i.test(`${err?.code} ${err?.message}`);
        done(reject, new DonnerError(oom ? "PARSE_TOO_BIG" : "PARSE_ERROR", oom ? "message needs too much memory to parse" : `parser crashed: ${err?.message}`), false);
      };
      const onExit = () => done(reject, new DonnerError("PARSE_ERROR", "parser exited"), false);
      const timer = setTimeout(() => done(reject, new DonnerError("PARSE_TIMEOUT", `parsing took longer than ${Math.round(this.timeoutMs / 1000)}s`), false), this.timeoutMs);
      w.on("message", onMessage);
      w.on("error", onError);
      w.on("exit", onExit);
      // Copy into a transferable buffer (the Buffer may be a slice of a shared pool).
      const copy = new Uint8Array(raw.length);
      copy.set(raw);
      w.postMessage({ id, raw: copy, opts }, [copy.buffer]);
    });
  }

  async close() {
    this.closed = true;
    const all = [...this.all];
    this.all.clear();
    this.idle = [];
    for (const r of this.waiting.splice(0)) r(null);
    await Promise.allSettled(all.map((w) => w.terminate()));
  }
}
