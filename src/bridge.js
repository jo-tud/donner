// HTTP client for the thunderbird-cli bridge (tb-bridge).
//
// donner only *reads* through the bridge. Every mutating action (reply, move, delete, ...)
// stays with thunderbird-cli, so donner never needs write access to your mailbox.

import { DonnerError } from "./errors.js";

export class BridgeClient {
  /**
   * @param {{host: string, port: number, authToken?: string|null, timeoutMs?: number}} opts
   */
  constructor({ host, port, authToken = null, timeoutMs = 120000 }) {
    const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    this.baseUrl = `http://${h}:${port}`;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body = null, opts = {}) {
    // Reads are idempotent: retry when a kept-alive socket was closed by the server between
    // requests (Node's HTTP server closes idle sockets after 5 s; fetch may pick one up).
    const retries = method === "GET" || path === "/messages/search" || path === "/messages/list" ? 2 : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(method, path, body, opts);
      } catch (err) {
        if (attempt >= retries || !err.transient || opts.signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  }

  async requestOnce(method, path, body = null, { timeoutMs = this.timeoutMs, signal = null } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== null) headers["Content-Type"] = "application/json";
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    // Ask the bridge to wait for Thunderbird as long as we are willing to wait.
    headers["X-TB-Timeout"] = String(timeoutMs);

    // One controller per request with a plain timer. (AbortSignal.any/timeout on a long-lived
    // signal accumulates internal bookkeeping in Node and caused multi-second stalls.)
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs + 5000);
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    let res;
    let text;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      text = await res.text();
    } catch (err) {
      cleanup();
      if (timedOut) {
        throw new DonnerError("TIMEOUT", `Thunderbird did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)}s.`,
          "Thunderbird may be busy (e.g. downloading a large folder). Retry later or raise bridge.timeoutMs.");
      }
      if (signal?.aborted) {
        throw signal.reason instanceof DonnerError ? signal.reason : new DonnerError("ABORTED", "Request cancelled.");
      }
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new DonnerError("TIMEOUT", `Thunderbird did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)}s.`,
          "Thunderbird may be busy (e.g. downloading a large folder). Retry later or raise bridge.timeoutMs.");
      }
      const code = err.cause?.code || err.code;
      if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE" || /other side closed|socket hang up/i.test(err.cause?.message || "")) {
        const e = new DonnerError("BRIDGE_UNREACHABLE", `Connection to the bridge was interrupted (${err.cause?.message || code}).`, "Retry; if it persists, restart `tb-bridge`.");
        e.transient = true;
        throw e;
      }
      if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
        throw new DonnerError("BRIDGE_UNREACHABLE", `Cannot reach the thunderbird-cli bridge at ${this.baseUrl}.`,
          "Start it with `tb-bridge` (from thunderbird-cli). Searching the existing index works without it.");
      }
      throw new DonnerError("BRIDGE_UNREACHABLE", `Cannot reach the thunderbird-cli bridge at ${this.baseUrl} (${err.cause?.message || err.message}).`,
        "Check the bridge host/port (`donner config`) and that `tb-bridge` is running.");
    }

    cleanup();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new DonnerError("BRIDGE_ERROR", `Bridge returned invalid JSON (HTTP ${res.status}).`);
    }
    text = null;

    if (res.status === 401) {
      throw new DonnerError("AUTH_REQUIRED", "The bridge requires an auth token.",
        "Set TB_AUTH_TOKEN (same value as the bridge) or bridge.authToken in the thunderbird-cli / donner config.");
    }
    if (res.status === 403) {
      throw new DonnerError("FORBIDDEN", data?.error || "The bridge refused the request.");
    }
    if (res.status === 503) {
      throw new DonnerError("EXTENSION_DISCONNECTED", "The bridge is running, but Thunderbird is not connected.",
        "Open Thunderbird and make sure the \"Thunderbird AI Bridge\" add-on is enabled.");
    }
    if (res.status >= 400) {
      const msg = data?.error?.message || data?.error || `HTTP ${res.status}`;
      if (/timed out/i.test(msg)) {
        throw new DonnerError("TIMEOUT", `Thunderbird did not answer ${method} ${path}: ${msg}`);
      }
      throw new DonnerError("THUNDERBIRD_ERROR", `Thunderbird error on ${method} ${path}: ${msg}`);
    }
    // The extension reports some failures in a 200 response.
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.error === "string" && Object.keys(data).length === 1) {
      if (/^Not found: /.test(data.error)) {
        throw new DonnerError("UNSUPPORTED", `The installed thunderbird-cli extension does not support ${method} ${path}.`,
          "Update the thunderbird-cli extension.");
      }
      throw new DonnerError(/not found/i.test(data.error) ? "NOT_FOUND" : "THUNDERBIRD_ERROR", data.error);
    }
    return data;
  }

  bridgeStatus() {
    return this.request("GET", "/bridge/status", null, { timeoutMs: 5000 });
  }

  health() {
    return this.request("GET", "/health", null, { timeoutMs: 15000 });
  }

  accounts() {
    return this.request("GET", "/accounts");
  }

  folders(accountId) {
    return this.request("GET", `/accounts/${encodeURIComponent(accountId)}/folders`);
  }

  folderInfo(folderId) {
    return this.request("POST", "/folders/info", { folderId });
  }

  /** All message headers in a folder (one response). */
  listFolder(folderId, limit, { timeoutMs } = {}) {
    return this.request("POST", "/messages/list", { folderId, limit }, { timeoutMs });
  }

  /** messages.query() based search; used for date-windowed listing and Message-ID lookup. */
  search(params, { timeoutMs } = {}) {
    return this.request("POST", "/messages/search", params, { timeoutMs });
  }

  headers(tbId) {
    return this.request("GET", `/messages/${Number(tbId)}/headers`, null, { timeoutMs: 15000 });
  }

  /** Message with text/html parts and attachment metadata (no raw source). */
  message(tbId, { signal } = {}) {
    return this.request("GET", `/messages/${Number(tbId)}`, null, { signal });
  }

  /** Raw RFC 822 source as a Buffer. */
  async raw(tbId, { signal } = {}) {
    const data = await this.request("GET", `/messages/${Number(tbId)}/raw`, null, { signal });
    const raw = data?.raw;
    if (typeof raw !== "string") throw new DonnerError("THUNDERBIRD_ERROR", "Raw message not available.");
    return binaryStringToBuffer(raw);
  }

  async attachment(tbId, partName, { signal } = {}) {
    const data = await this.request("POST", `/messages/${Number(tbId)}/attachment`, { partName }, { signal });
    return { ...data, data: Buffer.from(data?.data || "", "base64") };
  }
}

/** Thunderbird's getRaw() returns a "binary string" (one char per byte). */
export function binaryStringToBuffer(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return Buffer.from(s, "utf8");
  }
  return Buffer.from(s, "latin1");
}

export function bridgeFromConfig(cfg) {
  return new BridgeClient(cfg.bridge);
}
