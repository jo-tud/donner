// Configuration and on-disk locations.
//
// Precedence (highest first): DONNER_* env > TB_* env (shared with thunderbird-cli)
// > donner config file > thunderbird-cli config file > built-in defaults.

import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { isIP } from "node:net";

export const DEFAULTS = Object.freeze({
  bridge: {
    host: "127.0.0.1",
    port: 7700,
    authToken: null,
    timeoutMs: 120000,
  },
  index: {
    // Folder types (as reported by Thunderbird) that are never indexed.
    excludeFolderTypes: ["junk", "trash"],
    // Glob patterns matched against "<account name>/<folder path>" and "<folder id>".
    excludeFolders: [],
    // When non-empty, only folders matching one of these globs are indexed.
    includeFolders: [],
    // Account ids or names to index. Empty = all accounts.
    accounts: [],
    // Your own addresses in addition to the identities of your Thunderbird accounts and the
    // senders found in sent folders (e.g. old addresses in archived mail). Used by from:me,
    // count --by direction, people and triage.
    myAddresses: [],
    // Addresses that are wrongly detected as yours (e.g. a shared mailbox in a sent folder).
    notMyAddresses: [],
    bodies: true,
    attachments: true,
    // Messages larger than this are indexed from Thunderbird's text parts instead of the
    // raw RFC 822 source (no References header, no attachment text).
    maxMessageBytes: 8 * 1024 * 1024,
    maxAttachmentBytes: 20 * 1024 * 1024,
    // In messages above maxMessageBytes, attachments up to this size are fetched one by one.
    largeMessageAttachmentBytes: 2 * 1024 * 1024,
    maxAttachmentTextChars: 200000,
    maxBodyChars: 500000,
    concurrency: 4,
    // Hard limit per message for parsing (MIME, HTML, PDF, Office) in a worker thread.
    parseTimeoutMs: 60000,
    // PDF text via poppler's pdftotext: "auto" = when installed (much better coverage of
    // LibreOffice/FOP/ReportLab PDFs), true = same, false = built-in extractor only. It runs
    // sandboxed (private temp file, memory limit, timeout); set false to avoid native parsing.
    pdftotext: "auto",
    // Authentication-Results are only trusted from these receiving servers (authserv-id,
    // e.g. "mx.google.com"). Empty = trust the topmost transit header.
    trustedAuthservIds: [],
    // Folders with more messages than this are listed in date windows instead of one call.
    listChunk: 20000,
    // A full reconciliation (flags, tags, deletions in unchanged folders) runs at least this often.
    fullReconcileHours: 24,
  },
  mcp: {
    // The MCP server runs a quiet incremental sync in the background every N minutes.
    autoSync: true,
    syncIntervalMinutes: 10,
  },
  embeddings: {
    enabled: false,
    provider: "ollama", // "ollama" | "openai"
    url: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
    // Remote endpoints would send mail content off this machine. Opt-in only.
    allowRemote: false,
    apiKeyEnv: null,
    batchSize: 32,
    maxChars: 2000,
  },
});

function isWindows() {
  return platform() === "win32";
}

export function configDir(env = process.env) {
  if (env.DONNER_CONFIG_DIR) return env.DONNER_CONFIG_DIR;
  if (isWindows()) return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "donner");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "donner");
}

export function dataDir(env = process.env) {
  if (env.DONNER_DATA_DIR) return env.DONNER_DATA_DIR;
  if (isWindows()) return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "donner");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "donner");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "donner");
}

export function configPath(env = process.env) {
  return env.DONNER_CONFIG || join(configDir(env), "config.json");
}

export function dbPath(env = process.env, fileConfig = {}) {
  return env.DONNER_DB || fileConfig.db || join(dataDir(env), "index.sqlite");
}

const TB_CONFIG_PATHS = () => [
  join(homedir(), ".config", "thunderbird-cli", "config.json"),
  join(homedir(), ".config", "thunderbird-ai", "config.json"),
];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw Object.assign(new Error(`Cannot read config ${path}: ${err.message}`), { code: "CONFIG_ERROR" });
  }
}

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function intEnv(v, name) {
  if (v === undefined || v === "") return undefined;
  if (!/^\d+$/.test(String(v).trim())) {
    throw Object.assign(new Error(`${name} must be a number (got "${v}").`), { code: "CONFIG_ERROR" });
  }
  return Number.parseInt(v, 10);
}

/**
 * Load the effective configuration.
 * Returns { ...merged, paths: { config, db, tbConfig }, sources: {...} }
 */
export function loadConfig(env = process.env) {
  const cfgPath = configPath(env);
  const fileConfig = readJson(cfgPath) || {};

  let tbConfig = null;
  let tbConfigPath = null;
  for (const p of TB_CONFIG_PATHS()) {
    if (existsSync(p)) {
      try {
        tbConfig = JSON.parse(readFileSync(p, "utf8"));
        tbConfigPath = p;
        break;
      } catch {
        // thunderbird-cli ignores unreadable configs too
      }
    }
  }

  let cfg = structuredClone(DEFAULTS);
  const sources = { bridge: "defaults" };

  if (tbConfig) {
    const b = tbConfig.bridge || {};
    cfg.bridge = deepMerge(cfg.bridge, {
      host: b.host ?? tbConfig.host,
      port: b.httpPort ?? tbConfig.port,
      authToken: b.authToken ?? tbConfig.authToken ?? undefined,
    });
    sources.bridge = tbConfigPath;
  }
  cfg = deepMerge(cfg, fileConfig);
  if (fileConfig.bridge) sources.bridge = cfgPath;

  const tbEnv = {
    host: env.TB_BRIDGE_HOST || undefined,
    port: intEnv(env.TB_BRIDGE_PORT, "TB_BRIDGE_PORT"),
    authToken: env.TB_AUTH_TOKEN || undefined,
  };
  const donnerEnv = {
    host: env.DONNER_BRIDGE_HOST || undefined,
    port: intEnv(env.DONNER_BRIDGE_PORT, "DONNER_BRIDGE_PORT"),
    authToken: env.DONNER_AUTH_TOKEN || undefined,
    timeoutMs: intEnv(env.DONNER_BRIDGE_TIMEOUT, "DONNER_BRIDGE_TIMEOUT"),
  };
  if (Object.values(tbEnv).some((v) => v !== undefined)) sources.bridge = "TB_* environment";
  if (Object.values(donnerEnv).some((v) => v !== undefined)) sources.bridge = "DONNER_* environment";
  cfg.bridge = deepMerge(deepMerge(cfg.bridge, tbEnv), donnerEnv);
  cfg.bridge.port = Number(cfg.bridge.port);
  if (!Number.isInteger(cfg.bridge.port) || cfg.bridge.port < 1 || cfg.bridge.port > 65535) {
    throw Object.assign(new Error(`Invalid bridge port "${cfg.bridge.port}" (from ${sources.bridge}).`), { code: "CONFIG_ERROR" });
  }

  cfg.paths = {
    config: cfgPath,
    configExists: existsSync(cfgPath),
    db: dbPath(env, fileConfig),
    tbConfig: tbConfigPath,
    dataDir: dataDir(env),
  };
  cfg.sources = sources;
  return cfg;
}

/** Ensure a private directory exists (0700 on POSIX). */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isWindows()) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // not our directory (e.g. a shared parent); the file itself is still 0600
    }
  }
}

/** Write the user's config file with defaults (never overwrites). Returns the path. */
export function writeDefaultConfig(env = process.env) {
  const p = configPath(env);
  if (existsSync(p)) return { path: p, created: false };
  ensurePrivateDir(dirname(p));
  const template = {
    index: {
      excludeFolderTypes: DEFAULTS.index.excludeFolderTypes,
      excludeFolders: [],
      includeFolders: [],
      accounts: [],
      attachments: true,
    },
    embeddings: {
      enabled: false,
      provider: "ollama",
      url: DEFAULTS.embeddings.url,
      model: DEFAULTS.embeddings.model,
    },
  };
  writeFileSync(p, JSON.stringify(template, null, 2) + "\n", { mode: 0o600 });
  return { path: p, created: true };
}

/** Redact secrets for display. */
export function redactConfig(cfg) {
  const out = structuredClone(cfg);
  if (out.bridge?.authToken) out.bridge.authToken = "***";
  return out;
}

export function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // Exactly an IPv4 literal in 127.0.0.0/8 (not "127.0.0.1.example.com").
  return isIP(h) === 4 && h.startsWith("127.");
}
