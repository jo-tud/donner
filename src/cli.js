// Command-line interface.

import { parseArgs } from "node:util";
import { rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, writeDefaultConfig, redactConfig, isLoopbackHost, ensurePrivateDir } from "./config.js";
import { openDb, markForReparse, tx } from "./db.js";
import { BridgeClient } from "./bridge.js";
import { DonnerError, exitCodeFor } from "./errors.js";
import { sync } from "./sync.js";
import { acquireLock } from "./lock.js";
import * as ops from "./ops.js";
import { runSql } from "./sql.js";
import { SCHEMA_DOC } from "./schema-doc.js";
import { printJson, printError, makeStyle, wantColor, termWidth, fit, safeTerm, shortDate, table } from "./output.js";
import { parseRelative, QUERY_HELP } from "./query.js";
import { hasPdftotext } from "./pdf.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEARCH_FIELDS_TEXT = ops.SEARCH_FIELDS.join(",");
const PKG = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  pretty: { type: "boolean" },
  human: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  db: { type: "string" },
  "no-color": { type: "boolean" },
};

const FILTER_OPTIONS = {
  from: { type: "string" },
  to: { type: "string" },
  folder: { type: "string" },
  account: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  unread: { type: "boolean" },
  flagged: { type: "boolean" },
  "has-attachment": { type: "boolean" },
};

function filtersFrom(v) {
  return {
    from: v.from,
    to: v.to,
    folder: v.folder,
    account: v.account,
    since: v.since,
    until: v.until,
    unread: v.unread,
    flagged: v.flagged,
    hasAttachment: v["has-attachment"],
  };
}

function intOpt(v, name, def, min = 0) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new DonnerError("INVALID_ARGS", `--${name} must be a whole number ≥ ${min} (got "${v}").`);
  return n;
}

function durationMs(v, name) {
  const r = parseRelative(v, 0);
  if (r === null) {
    const m = String(v).match(/^(\d+)\s*(s|min)$/);
    if (m) return Number(m[1]) * (m[2] === "s" ? 1000 : 60000);
    throw new DonnerError("INVALID_ARGS", `--${name} must look like 30s, 5min, 1h, 1d (got "${v}").`);
  }
  return -r;
}

function ids(positionals, what = "id") {
  if (!positionals.length) throw new DonnerError("INVALID_ARGS", `Missing ${what}.`);
  return positionals.flatMap((p) => String(p).split(",")).filter(Boolean).map((p) => {
    const n = Number(String(p).replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) throw new DonnerError("INVALID_ARGS", `"${p}" is not a message id. Ids are the numbers shown by \`donner search\`.`);
    return n;
  });
}

// ─── Commands ───────────────────────────────────────────────────────

const COMMANDS = {};
function command(name, def) {
  COMMANDS[name] = def;
}

command("sync", {
  summary: "Index new and changed mail from Thunderbird",
  usage: "donner sync [--full] [--no-bodies] [--folder <id|glob>]... [--reparse <set,…>] [--quiet]",
  help: `Reads mail through the thunderbird-cli bridge and updates the local index.
Only changed folders are listed; only new messages are downloaded. Safe to interrupt
with Ctrl-C: progress is committed in batches and the next run continues.

  --full          list every folder (catches flag/tag changes in unchanged folders)
  --no-bodies     index headers only (fast; bodies can be added by a later sync)
  --folder <x>    only this folder (id like "account1://INBOX" or glob "Firma/Projekte/**")
  --reparse <set> read messages again from Thunderbird, e.g. after installing pdftotext:
                  pdf, attachments, empty, hidden, calendar, headers, auth, large, all
  --quiet         no progress output`,
  options: { full: { type: "boolean" }, "no-bodies": { type: "boolean" }, folder: { type: "string", multiple: true }, reparse: { type: "string" }, quiet: { type: "boolean", short: "q" } },
  async run(ctx, v) {
    const reparse = v.reparse ? v.reparse.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : null;
    const stats = await ctx.runSync({ full: v.full, bodies: v["no-bodies"] ? false : undefined, folders: v.folder || null, quiet: v.quiet, reparse });
    ctx.out(stats, () => renderSyncStats(ctx, stats));
    if (stats.aborted) process.exitCode = 130;
  },
});

command("watch", {
  summary: "Keep the index fresh: sync every few minutes",
  usage: "donner watch [--interval 5min] [--quiet]",
  help: `Runs \`donner sync\` in a loop. Survives Thunderbird or the bridge being offline
(it simply retries). Stop with Ctrl-C. For a background service see \`donner service\`.`,
  options: { interval: { type: "string" }, quiet: { type: "boolean", short: "q" } },
  async run(ctx, v) {
    const interval = v.interval ? durationMs(v.interval, "interval") : 5 * 60000;
    if (interval < 10000) throw new DonnerError("INVALID_ARGS", "--interval must be at least 10s.");
    const ac = new AbortController();
    ctx.onInterrupt(() => ac.abort());
    const log = (msg) => process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
    log(`watching; syncing every ${Math.round(interval / 1000)}s (Ctrl-C to stop)`);
    let backoff = interval;
    while (!ac.signal.aborted) {
      try {
        const s = await ctx.runSync({ quiet: true, signal: ac.signal });
        log(`sync: +${s.added} new, ${s.moved} moved, ${s.removed} removed, ${s.updated} updated${s.pending ? `, ${s.pending} pending` : ""} (${s.durationMs} ms)`);
        backoff = interval;
      } catch (err) {
        if (["BRIDGE_UNREACHABLE", "EXTENSION_DISCONNECTED", "TIMEOUT", "SYNC_RUNNING"].includes(err.code)) {
          log(`waiting: ${err.message}`);
          backoff = Math.min(backoff * 2, Math.max(interval, 30 * 60000));
        } else throw err;
      }
      await sleep(backoff, ac.signal);
    }
    log("stopped");
  },
});

command("search", {
  summary: "Full-text search with Gmail-style operators",
  usage: 'donner search <query...> [--limit 20] [--sort relevance|date|oldest|event] [--fields a,b] [filters]',
  help: `${QUERY_HELP}

Flags (same as operators): --from --to --folder --account --since --until --unread --flagged --has-attachment
  -n/--limit N  --offset N  --sort relevance|date|oldest|event
  --fields  ${SEARCH_FIELDS_TEXT}
            (listed fields are always present; without --fields empty/false values are omitted)
  --semantic  meaning-based search (needs \`donner embed\`)   --hybrid  words + meaning`,
  options: {
    ...FILTER_OPTIONS,
    limit: { type: "string", short: "n" },
    offset: { type: "string" },
    sort: { type: "string" },
    fields: { type: "string" },
    semantic: { type: "boolean" },
    hybrid: { type: "boolean" },
  },
  async run(ctx, v, pos) {
    const query = pos.join(" ");
    const db = ctx.dbRO();
    const opts = { query, limit: intOpt(v.limit, "limit", 20, 1), offset: intOpt(v.offset, "offset", 0), sort: v.sort, fields: v.fields ? v.fields.split(",") : undefined, filters: filtersFrom(v) };
    let res;
    if (v.semantic || v.hybrid) {
      const { semanticSearch } = await import("./semantic.js");
      res = await semanticSearch(db, ctx.cfg, { ...opts, mode: v.hybrid ? "hybrid" : "semantic" });
    } else res = ops.search(db, opts);
    const hl = new Map(res.results.map((r) => [r, r._hl]));
    for (const r of res.results) delete r._hl;
    ctx.out(res, () => renderSearch(ctx, res, query, hl));
  },
});

command("count", {
  summary: "Count matching mail, optionally grouped (month, from, direction, ...)",
  usage: "donner count <query...> [--by <key>[,<key>]] [filters]",
  help: `Uses the same query language as \`donner search\`. Duplicates (same Message-ID in several
folders) are counted once.

  --by KEY        year month week day weekday hour from domain folder account list thread direction
  --by K1,K2      two keys, e.g. --by year,direction (sent vs received per year)

direction: "sent" = written by one of your addresses (\`donner status\` lists them).`,
  options: { ...FILTER_OPTIONS, by: { type: "string" }, limit: { type: "string", short: "n" } },
  async run(ctx, v, pos) {
    const res = ops.count(ctx.dbRO(), { query: pos.join(" "), by: v.by, filters: filtersFrom(v), limit: intOpt(v.limit, "limit", 100, 1) });
    ctx.out(res, () => {
      if (!res.groups) return `${res.total}`;
      const keyText = (g) => (Array.isArray(g.key) ? g.key.map((k) => k ?? "(none)").join("  ") : g.key ?? "(none)");
      const max = Math.max(1, ...res.groups.map((g) => g.count));
      const w = Math.min(40, termWidth() - 40);
      const keyW = Math.min(40, Math.max(3, ...res.groups.map((g) => String(keyText(g)).length)));
      return [
        ...res.groups.map((g) => `${fit(safeTerm(keyText(g)), keyW)}  ${String(g.count).padStart(6)}  ${ctx.st.cyan("█".repeat(Math.max(1, Math.round((g.count / max) * w))))}${g.subject ? "  " + ctx.st.dim(fit(safeTerm(g.subject), 40).trimEnd()) : ""}`),
        ctx.st.dim(`${res.total} messages`),
      ].join("\n");
    });
  },
});

command("threads", {
  summary: "Conversations matching a query: size, time span, participants",
  usage: "donner threads [query...] [--min N] [--mine] [--sort last|first|count] [--limit 20] [filters]",
  help: `Lists whole conversations that contain at least one matching message.

  --min N          only threads with at least N messages
  --mine           only threads you wrote in (any of your addresses)
  --sort last      most recent activity first (default); first = oldest start; count = longest

Examples:
  donner threads --min 4 --mine                 long conversations you took part in
  donner threads with:mueller --sort first      every conversation with a person, since when
  donner threads "lieferverzug" --since 2025-01`,
  options: { ...FILTER_OPTIONS, min: { type: "string" }, mine: { type: "boolean" }, sort: { type: "string" }, limit: { type: "string", short: "n" }, offset: { type: "string" } },
  async run(ctx, v, pos) {
    const res = ops.threads(ctx.dbRO(), {
      query: pos.join(" "),
      minMessages: intOpt(v.min, "min", 1, 1),
      mine: !!v.mine,
      sort: v.sort || "last",
      limit: intOpt(v.limit, "limit", 20, 1),
      offset: intOpt(v.offset, "offset", 0),
      filters: filtersFrom(v),
    });
    ctx.out(res, () =>
      [
        table(
          res.threads.map((t) => ({
            span: `${shortDate(t.first).trim()} – ${shortDate(t.last).trim()}`,
            messages: t.messages,
            by_me: t.by_me,
            subject: t.subject,
            participants: t.participants.map((p) => p.replace(/\s*<[^>]*>$/, "")).join(", "),
            id: t.last_id,
          })),
          [
            { key: "span", label: "First – last" },
            { key: "messages", label: "Msgs", align: "right" },
            { key: "by_me", label: "Me", align: "right" },
            { key: "subject", label: "Subject", max: 38 },
            { key: "participants", label: "With", max: 40 },
            { key: "id", label: "Id", align: "right" },
          ],
          ctx.st
        ) || "No matches.",
        res.threads.length ? ctx.st.dim(`${res.total} threads${res.hasMore ? " (more with --offset)" : ""} · read one: donner thread <id>`) : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  },
});

command("show", {
  summary: "Read one or more messages from the index",
  usage: "donner show <id...> [--max-body 20000] [--quoted] [--attachments]",
  help: `  --max-body N     truncate the body (characters, default 20000)
  --quoted         include quoted history and signature
  --attachments    include extracted attachment text (--max-attachment N, default 5000)`,
  options: { "max-body": { type: "string" }, quoted: { type: "boolean" }, attachments: { type: "boolean" }, "max-attachment": { type: "string" } },
  async run(ctx, v, pos) {
    const list = ids(pos);
    const opts = { maxBody: intOpt(v["max-body"], "max-body", 20000), quoted: v.quoted, attachments: v.attachments, maxAttachment: intOpt(v["max-attachment"], "max-attachment", 5000) };
    const db = ctx.dbRO();
    // Always a list, so scripts and agents see one shape; a single unknown id is an error.
    const messages = list.length === 1 ? [ops.show(db, list[0], opts)] : ops.showMany(db, list, opts);
    ctx.out({ notice: ops.UNTRUSTED_NOTICE, messages }, () => messages.map((m) => renderMessage(ctx, m)).join("\n\n" + ctx.st.dim("─".repeat(Math.min(termWidth(), 80))) + "\n\n"));
  },
});

command("thread", {
  summary: "Show a whole conversation, oldest first",
  usage: "donner thread <id> [--max-body 3000] [--quoted]",
  options: { "max-body": { type: "string" }, quoted: { type: "boolean" } },
  async run(ctx, v, pos) {
    const [id] = ids(pos);
    const t = ops.thread(ctx.dbRO(), id, { maxBody: intOpt(v["max-body"], "max-body", 3000), quoted: v.quoted });
    ctx.out({ notice: ops.UNTRUSTED_NOTICE, ...t }, () => {
      const st = ctx.st;
      const head = `${st.bold(safeTerm(t.subject))}\n${st.dim(`${t.count} messages · ${shortDate(t.first)} – ${shortDate(t.last)} · ${t.participants.length} people`)}`;
      const parts = t.messages.map((m) => `${st.cyan("#" + m.id)}  ${st.dim(m.date.slice(0, 16).replace("T", " "))}  ${st.bold(safeTerm(m.from))}\n${indent(safeTerm(m.body || "(empty)"))}${m.attachments ? "\n" + st.dim("  📎 " + m.attachments.map(safeTerm).join(", ")) : ""}`);
      return [head, ...parts].join("\n\n");
    });
  },
});

command("people", {
  summary: "Who you correspond with (counts, first/last contact)",
  usage: "donner people [name or address] [--since 1y] [--limit 20]",
  options: { since: { type: "string" }, limit: { type: "string", short: "n" } },
  async run(ctx, v, pos) {
    const res = ops.people(ctx.dbRO(), { query: pos.join(" "), since: v.since, limit: intOpt(v.limit, "limit", 20, 1) });
    ctx.out(res, () =>
      table(
        res.people.map((p) => ({ ...p, name: p.name || "", last_received: shortDate(p.last_received).trim() || "-", last_sent: shortDate(p.last_sent).trim() || "-" })),
        [
          { key: "name", label: "Name", max: 28 },
          { key: "addr", label: "Address", max: 36 },
          { key: "received", label: "Recv", align: "right" },
          { key: "sent", label: "Sent", align: "right" },
          { key: "last_received", label: "Last from them" },
          { key: "last_sent", label: "Last to them" },
        ],
        ctx.st
      ) || "No matches."
    );
  },
});

command("attachment", {
  summary: "Print an attachment's extracted text, or save the file",
  usage: "donner attachment <id> <idx> [--save <path>]",
  help: `Without --save, prints the text donner extracted (PDF, Office, ICS, ...).
With --save, fetches the original file from Thunderbird (needs the bridge) and writes it.`,
  options: { save: { type: "string" }, force: { type: "boolean" } },
  async run(ctx, v, pos) {
    const [id, idx] = ids(pos, "id and attachment number");
    if (!idx) throw new DonnerError("INVALID_ARGS", "Missing attachment number (see `donner show <id>`).");
    const db = v.save ? ctx.dbRW() : ctx.dbRO();
    const a = db.prepare("SELECT a.*, m.mid FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.message_id = ? AND a.idx = ?").get(id, idx);
    if (!a) throw new DonnerError("NOT_FOUND", `Message ${id} has no attachment #${idx}.`);
    if (!v.save) {
      const data = { id, idx, filename: a.filename, type: a.content_type, size: a.size, text_state: a.text_state, notice: ops.UNTRUSTED_NOTICE, text: a.text || "" };
      ctx.out(data, () => a.text ? safeTerm(a.text) : ctx.st.dim(`(no text extracted: ${a.text_state})`));
      return;
    }
    let target = resolvePath(v.save);
    if (existsSync(target) && statSync(target).isDirectory()) {
      // Save into the directory under the original name (made safe: no path parts).
      const safe = String(a.filename || `attachment-${id}-${idx}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 200) || `attachment-${id}-${idx}`;
      target = join(target, safe);
    }
    if (existsSync(target) && !v.force) throw new DonnerError("INVALID_ARGS", `${target} exists.`, "Use --force to overwrite.");
    const { saveAttachment } = await import("./fetch-attachment.js");
    const res = await saveAttachment({ db, bridge: ctx.bridge(), cfg: ctx.cfg, id, idx, target });
    ctx.out(res, () => `saved ${res.bytes} bytes to ${res.path}`);
  },
});

command("sql", {
  summary: "Read-only SQL over the index (see `donner schema`)",
  usage: 'donner sql "<SELECT ...>" [--max-rows 500] [--max-cell 2000] [--timeout 15s]',
  options: { "max-rows": { type: "string" }, "max-cell": { type: "string" }, timeout: { type: "string" } },
  async run(ctx, v, pos) {
    const sql = pos.join(" ");
    ctx.dbRO().close();
    const res = await runSql(ctx.dbPath, sql, {
      maxRows: intOpt(v["max-rows"], "max-rows", 500),
      maxCell: intOpt(v["max-cell"], "max-cell", 2000),
      timeoutMs: v.timeout ? durationMs(v.timeout, "timeout") : 15000,
    });
    ctx.out(res, () => {
      if (!res.rows.length) return ctx.st.dim("(no rows)");
      return table(res.rows, res.columns.map((c) => ({ key: c, label: c, max: 50 })), ctx.st) + (res.truncated ? "\n" + ctx.st.yellow(`(truncated to ${res.rows.length} rows)`) : "");
    });
  },
});

command("schema", {
  summary: "Describe the index tables for SQL queries",
  usage: "donner schema",
  async run(ctx) {
    ctx.out({ schema: SCHEMA_DOC }, () => SCHEMA_DOC);
  },
});

command("status", {
  summary: "What is indexed, how fresh, how big",
  usage: "donner status [--folders]",
  options: { folders: { type: "boolean" } },
  async run(ctx, v) {
    const s = ops.status(ctx.dbRO(), ctx.dbPath);
    if (!v.folders) delete s.folders;
    ctx.out(s, () => renderStatus(ctx, s, v.folders));
  },
});

command("doctor", {
  summary: "Check the setup and explain what to fix",
  usage: "donner doctor",
  async run(ctx) {
    const checks = await doctor(ctx);
    ctx.out({ healthy: checks.every((c) => c.status !== "fail"), checks }, () =>
      checks.map((c) => `${c.status === "ok" ? ctx.st.green("✔") : c.status === "warn" ? ctx.st.yellow("!") : ctx.st.red("✘")} ${c.name}: ${c.detail}${c.fix ? "\n    " + ctx.st.dim("→ " + c.fix) : ""}`).join("\n")
    );
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
  },
});

command("resolve", {
  summary: "Current Thunderbird id for donner ids (for tb reply/move/...)",
  usage: "donner resolve <id...>",
  help: `thunderbird-cli (\`tb\`) performs actions such as reply, move, tag or delete. Its message ids
change when Thunderbird restarts, so donner verifies them before handing them out:
  tb reply $(donner resolve 1234 --json | jq '.data.resolved[0].tb_id') --body "..."`,
  async run(ctx, v, pos) {
    const res = await ops.resolve(ctx.dbRW(), ctx.bridge(), ids(pos));
    ctx.out(res, () => res.resolved.map((r) => (r.tb_id ? `${r.id} → tb ${r.tb_id}  ${ctx.st.dim(safeTerm(r.subject || ""))}` : `${r.id} → ${ctx.st.red(r.error)}`)).join("\n"));
  },
});

command("embed", {
  summary: "Compute embeddings for meaning-based search (optional, local model)",
  usage: "donner embed [--limit N] [--rebuild]",
  help: `Uses a local embedding model (default: Ollama with nomic-embed-text at 127.0.0.1:11434).
Configure in the config file under "embeddings". Remote endpoints require "allowRemote": true
because mail content would leave this machine.`,
  options: { limit: { type: "string" }, rebuild: { type: "boolean" }, quiet: { type: "boolean", short: "q" } },
  async run(ctx, v) {
    const { embedAll } = await import("./semantic.js");
    const db = ctx.dbRW();
    const release = acquireLock(ctx.dbPath + ".lock");
    try {
      const ac = new AbortController();
      ctx.onInterrupt(() => ac.abort());
      const progress = !v.quiet && process.stderr.isTTY ? (d, t) => process.stderr.write(`\rembedding ${d}/${t}   `) : () => {};
      const res = await embedAll(db, ctx.cfg, { limit: v.limit ? intOpt(v.limit, "limit") : null, rebuild: v.rebuild, onProgress: progress, signal: ac.signal });
      if (!v.quiet && process.stderr.isTTY) process.stderr.write("\n");
      ctx.out(res, () => `embedded ${res.embedded} messages with ${res.model} (${res.total} total, ${res.durationMs} ms)`);
    } finally {
      release();
    }
  },
});

command("config", {
  summary: "Show the effective configuration, or create a config file",
  usage: "donner config [show|path|init]",
  async run(ctx, v, pos) {
    const sub = pos[0] || "show";
    if (sub === "path") return ctx.out({ config: ctx.cfg.paths.config, db: ctx.dbPath }, () => `config: ${ctx.cfg.paths.config}\nindex:  ${ctx.dbPath}`);
    if (sub === "init") {
      const r = writeDefaultConfig();
      return ctx.out(r, () => (r.created ? `created ${r.path}` : `${r.path} already exists (unchanged)`));
    }
    if (sub !== "show") throw new DonnerError("INVALID_ARGS", `Unknown config subcommand "${sub}".`, "Use show, path or init.");
    const c = redactConfig(ctx.cfg);
    ctx.out(c, () => JSON.stringify(c, null, 2));
  },
});

command("mcp", {
  summary: "Run the MCP server (stdio) for Claude Desktop and other MCP clients",
  usage: "donner mcp",
  help: `Read-only MCP server exposing search, read, thread, count, people, SQL and status.
Claude Desktop config:
  { "mcpServers": { "donner": { "command": "donner", "args": ["mcp"] } } }
Claude Code:
  claude mcp add donner -- donner mcp`,
  async run(ctx) {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer({ cfg: ctx.cfg, dbPath: ctx.dbPath, version: PKG.version });
  },
});

command("skill", {
  summary: "Install the agent skill (SKILL.md) for Claude Code",
  usage: "donner skill [install|print|path] [--dir ~/.claude/skills]",
  options: { dir: { type: "string" }, force: { type: "boolean" } },
  async run(ctx, v, pos) {
    const sub = pos[0] || "install";
    const src = join(here, "..", "skills", "donner", "SKILL.md");
    if (sub === "print") return ctx.out({ skill: readFileSync(src, "utf8") }, () => readFileSync(src, "utf8"));
    if (sub === "path") return ctx.out({ path: src }, () => src);
    if (sub !== "install") throw new DonnerError("INVALID_ARGS", `Unknown skill subcommand "${sub}".`, "Use install, print or path.");
    const dir = join(v.dir ? resolvePath(v.dir.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), ".claude", "skills"), "donner");
    const target = join(dir, "SKILL.md");
    if (existsSync(target) && !v.force && readFileSync(target, "utf8") !== readFileSync(src, "utf8")) {
      throw new DonnerError("INVALID_ARGS", `${target} exists and differs.`, "Use --force to overwrite.");
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, readFileSync(src));
    ctx.out({ installed: target }, () => `installed ${target}`);
  },
});

command("service", {
  summary: "Install a background service that keeps the index fresh",
  usage: "donner service [install|uninstall|print] [--interval 10min]",
  help: `Linux: systemd user service. macOS: launchd agent. Windows: prints a Task Scheduler command.
The service runs \`donner watch\`.`,
  options: { interval: { type: "string" } },
  async run(ctx, v, pos) {
    const { serviceCommand } = await import("./service.js");
    const res = await serviceCommand(pos[0] || "print", { interval: v.interval || "10min" });
    ctx.out(res, () => res.message);
  },
});

command("setup", {
  summary: "Set up everything in one go (also the update step): Claude, skill, index, background service",
  usage: "donner setup [--yes] [--no-sync] [--no-service] [--no-claude] [--interval 10min]",
  help: `Checks Thunderbird/thunderbird-cli, registers donner with Claude Desktop and Claude Code
(if installed), installs the agent skill, builds or updates the index, asks about addresses that
look like yours, and installs the background service that keeps the index fresh.

Safe to run again at any time — after updating donner, it updates the registrations, the skill
and the service and upgrades the index.

  --yes           no questions (addresses are only suggested, not added)
  --no-sync       do not build the index now (the background service will)
  --no-service    no background service (the MCP server still syncs while Claude runs)
  --no-claude     do not touch Claude Desktop / Claude Code / the skill
  --interval T    background sync interval (default 10min)`,
  options: { yes: { type: "boolean", short: "y" }, "no-sync": { type: "boolean" }, "no-service": { type: "boolean" }, "no-claude": { type: "boolean" }, interval: { type: "string" } },
  async run(ctx, v) {
    const setup = await import("./setup.js");
    const { serviceCommand } = await import("./service.js");
    const st = ctx.st;
    const steps = [];
    const interactive = !ctx.json && !v.yes && process.stdin.isTTY && process.stdout.isTTY;
    const icon = { ok: st.green("✔"), warn: st.yellow("!"), skip: st.dim("–"), fail: st.red("✘") };
    const step = (status, name, detail, fix) => {
      steps.push({ name, status, detail, ...(fix ? { fix } : {}) });
      if (!ctx.json) process.stdout.write(`${icon[status]} ${st.bold(name)}: ${detail}${fix ? `\n    ${st.dim("→ " + fix)}` : ""}\n`);
    };
    const ask = async (q) => {
      if (!interactive) return false;
      const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^(y|j|yes|ja)$/i.test((await rl.question(`${q} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    };
    const os = process.platform;
    const serviceWanted = !v["no-service"];
    const interval = v.interval || "10min";

    // 1. Configuration
    const cfgFile = writeDefaultConfig();
    step("ok", "config", cfgFile.created ? `created ${cfgFile.path}` : cfgFile.path);

    // 2. Thunderbird and thunderbird-cli
    let bridgeOk = false;
    try {
      const s = await ctx.bridge().bridgeStatus();
      if (s?.extension === "connected") {
        bridgeOk = true;
        step("ok", "thunderbird", "Thunderbird is connected through thunderbird-cli");
      } else {
        step("warn", "thunderbird", "tb-bridge runs, but Thunderbird is not connected", "Open Thunderbird and enable the \"Thunderbird AI Bridge\" add-on, then run `donner setup` again.");
      }
    } catch (err) {
      step("warn", "thunderbird", err.code === "AUTH_REQUIRED" ? err.message : "the thunderbird-cli bridge is not reachable",
        err.code === "AUTH_REQUIRED" ? err.hint : "Install thunderbird-cli (https://github.com/vitalio-sh/thunderbird-cli#quick-start), start `tb-bridge` and Thunderbird, then run `donner setup` again.");
    }

    // 3. PDF text
    const wantPdf = ctx.cfg.index.pdftotext !== false && ctx.cfg.index.pdftotext !== "false";
    if (!wantPdf) step("skip", "pdf text", "pdftotext disabled in the config");
    else if (hasPdftotext()) step("ok", "pdf text", "pdftotext (poppler) found");
    else {
      const how = os === "darwin" ? "brew install poppler" : os === "win32" ? "install poppler for Windows and put pdftotext on PATH" : "sudo apt install poppler-utils   (Fedora: sudo dnf install poppler-utils)";
      step("warn", "pdf text", "pdftotext not installed — text in many PDFs will not be found", `${how}; afterwards: donner sync --reparse pdf`);
    }

    // 4. Claude Desktop, Claude Code, skill
    let restartDesktop = false;
    if (v["no-claude"]) step("skip", "claude", "skipped (--no-claude)");
    else {
      const d = setup.registerClaudeDesktop();
      if (d.status === "not-found") step("skip", "claude desktop", "not installed");
      else if (d.status === "error") step("fail", "claude desktop", d.message, `Add it by hand: "mcpServers": {"donner": ${JSON.stringify(setup.mcpServerEntry())}}`);
      else {
        restartDesktop = d.status !== "unchanged";
        step("ok", "claude desktop", `${d.status === "unchanged" ? "already registered" : `${d.status} the donner MCP server`} (${d.path})`);
      }
      const c = setup.registerClaudeCode();
      if (c.status === "not-found") step("skip", "claude code", "not installed");
      else if (c.status === "error") step("fail", "claude code", c.message, `claude mcp add --scope user donner -- ${[setup.mcpServerEntry().command, ...setup.mcpServerEntry().args].map((x) => JSON.stringify(x)).join(" ")}`);
      else step("ok", "claude code", `${c.status} the donner MCP server (user scope)`);
      const k = setup.installSkill();
      if (k.status === "not-found") step("skip", "skill", "Claude Code not found");
      else step("ok", "skill", `${k.status === "unchanged" ? "up to date" : k.status} (${k.path})`);
    }

    // 5. Index — stop a running service first so the new version does the (re)indexing.
    const stopped = serviceWanted && (os === "linux" || os === "darwin") ? (await serviceCommand("stop", { interval })).stopped : false;
    let syncStats = null;
    if (v["no-sync"]) step("skip", "index", serviceWanted ? "not built now; the background service will build it" : "not built now; run `donner sync`");
    else if (!bridgeOk) step("skip", "index", "needs Thunderbird; run `donner setup` or `donner sync` once it is connected");
    else {
      if (!ctx.json) process.stdout.write(st.dim("  building the index — the first run takes a while (Thunderbird hands out one message at a time).\n  Ctrl-C is safe: the next sync continues where it stopped.\n"));
      try {
        syncStats = await ctx.runSync({});
        if (syncStats.aborted) step("warn", "index", `interrupted — ${syncStats.pending} messages still to read`, serviceWanted ? "The background service continues." : "Run `donner sync` to continue.");
        else step("ok", "index", `${syncStats.added} new, ${syncStats.contentErrors ? `${syncStats.contentErrors} unreadable, ` : ""}took ${Math.round(syncStats.durationMs / 1000)}s`);
      } catch (err) {
        if (err.code === "SYNC_RUNNING") step("warn", "index", "another donner process (e.g. the MCP server in Claude) is syncing right now", "It continues on its own; check progress with `donner status`.");
        else step("fail", "index", err.message, err.hint);
      }
    }

    // 6. Addresses that look like the user's
    try {
      const { suggestAddresses, refreshIdentities, refreshContacts } = await import("./identity.js");
      const db = openDb(ctx.dbPath);
      try {
        const maybe = suggestAddresses(db);
        const yes = [];
        for (const a of maybe) {
          if (await ask(`  Is ${a.addr} yours? (${a.messages} mails sent as "${a.name}")`)) yes.push(a.addr);
        }
        if (yes.length) {
          const r = setup.addMyAddresses(yes);
          tx(db, () => {
            refreshIdentities(db, { myAddresses: r.myAddresses, notMyAddresses: ctx.cfg.index.notMyAddresses });
            refreshContacts(db);
          });
          step("ok", "my addresses", `added ${yes.join(", ")} to ${r.path}`);
        }
        const left = maybe.filter((a) => !yes.includes(a.addr));
        if (left.length) {
          step("warn", "my addresses", `probably yours: ${left.map((a) => a.addr).join(", ")}`, `If they are, add them to ${ctx.cfg.paths.config}: "index": {"myAddresses": ${JSON.stringify(left.map((a) => a.addr))}}`);
        } else if (!yes.length) {
          const n = db.prepare("SELECT count(*) AS n FROM identities").get().n;
          if (n) step("ok", "my addresses", `${n} known`);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      if (err.code !== "NO_INDEX") step("warn", "my addresses", err.message);
    }

    // 7. Background service
    if (!serviceWanted) step("skip", "service", "skipped (--no-service)");
    else {
      try {
        const r = await serviceCommand("install", { interval });
        if (r.enabled || r.loaded) step("ok", "service", `${stopped ? "restarted" : "installed"}; syncs every ${interval}`);
        else if (r.command) step("warn", "service", "Windows: run this once to sync at logon", r.command);
        else step("warn", "service", r.message.split("\n")[0], r.message.split("\n").slice(1).join(" ") || undefined);
      } catch (err) {
        step("fail", "service", err.message);
      }
    }

    const next = [];
    if (restartDesktop) next.push("Restart Claude Desktop to load donner.");
    next.push('Try: donner search "rechnung" · donner people · donner threads --min 4 --mine');
    ctx.out({ steps, next }, () => "\n" + next.map((n) => `${st.bold("→")} ${n}`).join("\n"));
    if (steps.some((s) => s.status === "fail")) process.exitCode = 1;
  },
});

command("uninstall", {
  summary: "Remove donner's service, Claude registrations and skill (--purge: also index and config)",
  usage: "donner uninstall [--purge] [--yes]",
  help: `Removes the background service, the donner entries in Claude Desktop and Claude Code and the
skill. With --purge also deletes the index and the donner config file. Thunderbird is not touched.
Afterwards: npm uninstall -g donner-mail`,
  options: { purge: { type: "boolean" }, yes: { type: "boolean", short: "y" } },
  async run(ctx, v) {
    const setup = await import("./setup.js");
    const { serviceCommand } = await import("./service.js");
    if (v.purge && !v.yes) throw new DonnerError("INVALID_ARGS", `--purge deletes the index (${ctx.dbPath}) and the config (${ctx.cfg.paths.config}).`, "Run `donner uninstall --purge --yes` to confirm. Your mail in Thunderbird is not affected.");
    const done = [];
    const svc = await serviceCommand("uninstall", { interval: "10min" });
    done.push({ name: "service", detail: svc.message });
    const d = setup.registerClaudeDesktop({ remove: true });
    done.push({ name: "claude desktop", detail: d.status });
    const c = setup.registerClaudeCode({ remove: true });
    done.push({ name: "claude code", detail: c.status });
    const k = setup.installSkill({ remove: true });
    done.push({ name: "skill", detail: k.status });
    if (v.purge) {
      const removed = [];
      for (const f of [ctx.dbPath, ctx.dbPath + "-wal", ctx.dbPath + "-shm", ctx.dbPath + ".lock", ctx.cfg.paths.config]) {
        if (existsSync(f)) {
          rmSync(f);
          removed.push(f);
        }
      }
      done.push({ name: "files", detail: removed.length ? `deleted ${removed.join(", ")}` : "nothing to delete" });
    }
    ctx.out({ removed: done }, () => [...done.map((x) => `${ctx.st.green("✔")} ${ctx.st.bold(x.name)}: ${x.detail}`), ctx.st.dim("Finally: npm uninstall -g donner-mail")].join("\n"));
  },
});

command("reset", {
  summary: "Delete the index (Thunderbird is not touched)",
  usage: "donner reset --yes",
  options: { yes: { type: "boolean" } },
  async run(ctx, v) {
    if (!v.yes) throw new DonnerError("INVALID_ARGS", `This deletes ${ctx.dbPath}.`, "Run `donner reset --yes` to confirm. Your mail in Thunderbird is not affected.");
    const release = acquireLock(ctx.dbPath + ".lock");
    try {
      const removed = [];
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(ctx.dbPath + suffix)) {
          rmSync(ctx.dbPath + suffix);
          removed.push(ctx.dbPath + suffix);
        }
      }
      ctx.out({ removed }, () => (removed.length ? `deleted ${removed.join(", ")}` : "nothing to delete"));
    } finally {
      release();
    }
  },
});

command("version", {
  summary: "Print the version",
  usage: "donner version",
  async run(ctx) {
    ctx.out({ version: PKG.version, node: process.version }, () => `donner ${PKG.version} (node ${process.version})`);
  },
});

command("help", {
  summary: "Show help for a command",
  usage: "donner help [command]",
  async run(ctx, v, pos) {
    process.stdout.write(helpText(pos[0], ctx.st) + "\n");
  },
});

// ─── Rendering ──────────────────────────────────────────────────────

function indent(s, n = 2) {
  return String(s).split("\n").map((l) => " ".repeat(n) + l).join("\n");
}

function highlight(ctx, s) {
  return safeTerm(s)
    .replace(/\u0001([^\u0002]*)(?:\u0002|$)/g, (_, w) => ctx.st.bold(ctx.st.yellow(w)))
    .replace(/[\u0001\u0002]/g, "");
}

function renderSearch(ctx, res, query, hl = new Map()) {
  const st = ctx.st;
  if (!res.results.length) {
    if (res.note) return st.yellow(res.note);
    return st.dim(`No results${query ? ` for "${safeTerm(query)}"` : ""}.`) + (res.total === 0 ? "\n" + st.dim("Tip: `donner status` shows what is indexed; `donner sync` updates the index.") : "");
  }
  const w = termWidth();
  const lines = [];
  for (const r of res.results) {
    const flags = `${r.unread ? st.blue("●") : " "}${r.flagged ? st.yellow("★") : " "}${r.attachments ? "📎" : "  "}`;
    const fromW = Math.min(24, Math.floor(w * 0.22));
    const idStr = st.cyan(String(r.id).padStart(6));
    const subjW = Math.max(20, w - 6 - 2 - 10 - 2 - fromW - 2 - 5 - 2);
    lines.push(`${idStr}  ${st.dim(shortDate(r.date))}  ${fit(safeTerm(r.from ? r.from.replace(/\s*<.*>$/, "") : ""), fromW)}  ${flags} ${st.bold(fit(safeTerm(r.subject || "(no subject)"), subjW))}`);
    if (r.event) {
      const e = r.event;
      const when = `${(e.start || "").slice(0, 16).replace("T", " ")}${e.repeats ? `, ${e.repeats}` : ""}`;
      const what = [e.summary, e.location].filter(Boolean).join(" @ ");
      lines.push(`        ${e.cancelled ? st.red("✗ cancelled ") : "📅 "}${st.yellow(safeTerm(when))}  ${fit(safeTerm(what), Math.max(10, w - 40)).trimEnd()}`);
    }
    const marked = hl.get(r);
    if (marked) {
      const flat = marked.replace(/\s+/g, " ").trim();
      const cut = [...flat].slice(0, w - 10).join("");
      lines.push(`        ${highlight(ctx, cut)}`);
    } else if (r.snippet) lines.push(`        ${st.dim(fit(safeTerm(r.snippet), w - 10).trimEnd())}`);
  }
  const shown = res.offset + res.results.length;
  lines.push(st.dim(`${res.offset + 1}–${shown} of ${res.total}${res.hasMore ? ` · more: --offset ${shown}` : ""} · read: donner show <id> · conversation: donner thread <id>`));
  return lines.join("\n");
}

function renderMessage(ctx, m) {
  const st = ctx.st;
  if (m.error) return st.red(`#${m.id}: ${m.error}`);
  const head = [
    `${st.cyan("#" + m.id)}  ${st.bold(safeTerm(m.subject || "(no subject)"))}`,
    `${st.dim("From:")}    ${safeTerm(m.from)}`,
    m.to?.length ? `${st.dim("To:")}      ${safeTerm(m.to.join(", "))}` : null,
    m.cc?.length ? `${st.dim("Cc:")}      ${safeTerm(m.cc.join(", "))}` : null,
    `${st.dim("Date:")}    ${m.date?.replace("T", " ").slice(0, 16)}   ${st.dim("Folder:")} ${safeTerm(m.folder)}   ${st.dim("Thread:")} ${m.thread}`,
  ].filter(Boolean);
  const t = m.trust || {};
  const warn = [];
  if (t.warning) warn.push(t.warning);
  if (t.hidden_content_removed) warn.push("hidden content was removed from this mail");
  if (t.junk) warn.push("marked as junk");
  if (warn.length) head.push(st.yellow(`⚠ ${warn.join("; ")}`));
  if (m.attachments?.length) head.push(`${st.dim("Attach:")}  ${m.attachments.map((a) => `[${a.idx}] ${safeTerm(a.filename || "unnamed")}`).join("  ")}`);
  let body = safeTerm(m.body || st.dim("(no text)"));
  if (m.body_truncated) body += "\n" + st.dim(`… truncated (${m.body_truncated.total} chars; use --max-body)`);
  if (m.quoted) body += "\n\n" + st.dim(safeTerm(m.quoted));
  else if (m.quoted_chars) body += "\n" + st.dim(`[${m.quoted_chars} chars of quoted text hidden; --quoted shows them]`);
  const atts = (m.attachments || []).filter((a) => a.content).map((a) => `${st.bold(`── Attachment ${a.idx}: ${safeTerm(a.filename)}`)}\n${safeTerm(a.content)}`);
  if (m.note) body += "\n" + st.yellow(m.note);
  return [head.join("\n"), "", body, ...atts].join("\n");
}

function renderStatus(ctx, s, withFolders) {
  const st = ctx.st;
  const mb = s.db.bytes ? `${(s.db.bytes / 1048576).toFixed(1)} MB` : "?";
  const content = Object.entries(s.content).map(([k, n]) => `${n} ${k}`).join(", ") || "none";
  const lines = [
    `${st.bold("Messages")}   ${s.messages}  ${st.dim(`(${content})`)}`,
    `${st.bold("Range")}      ${shortDate(s.oldest)} – ${shortDate(s.newest)}`,
    `${st.bold("Threads")}    ${s.threads}    ${st.bold("Attachments")} ${s.attachments}${s.embeddings ? `    ${st.bold("Embeddings")} ${s.embeddings}` : ""}`,
    `${st.bold("Last sync")}  ${s.last_sync ? `${s.last_sync.replace("T", " ").slice(0, 16)} (${s.last_sync_age_minutes} min ago)` : st.yellow("never — run `donner sync`")}`,
    `${st.bold("Index")}      ${s.db.path} (${mb})`,
    `${st.bold("Accounts")}   ${s.accounts.map((a) => safeTerm(a.name)).join(", ") || "-"}`,
    `${st.bold("Me")}         ${(s.my_addresses || []).map((a) => safeTerm(a.addr) + (a.source === "sent" ? st.dim(" (sent folder)") : a.source === "config" ? st.dim(" (config)") : "")).join(", ") || "-"}`,
    ...(s.possibly_mine?.length ? [`${st.bold("Maybe me")}   ${st.yellow(s.possibly_mine.map((a) => safeTerm(a.addr)).join(", "))} ${st.dim("(same name; add to index.myAddresses if yours — see donner doctor)")}`] : []),
  ];
  if (withFolders && s.folders) {
    lines.push("");
    lines.push(
      table(
        s.folders.map((f) => ({ ...f, state: f.indexed ? (f.error ? "error" : "") : "excluded" })),
        [
          { key: "folder", label: "Folder", max: 40 },
          { key: "thunderbird", label: "In TB", align: "right" },
          { key: "in_index", label: "Indexed", align: "right" },
          { key: "state", label: "" },
        ],
        st
      )
    );
  } else lines.push(st.dim("per-folder details: donner status --folders"));
  return lines.join("\n");
}

function renderSyncStats(ctx, s) {
  const st = ctx.st;
  const parts = [`${st.green("✔")} synced in ${(s.durationMs / 1000).toFixed(1)}s: ${s.added} new, ${s.moved} moved, ${s.removed} removed, ${s.updated} flag changes`];
  if (s.contentErrors) parts.push(st.yellow(`${s.contentErrors} messages could not be read (retried next sync)`));
  if (s.epochChanged) parts.push(st.dim("Thunderbird was restarted since the last sync; message ids refreshed."));
  if (s.aborted) parts.push(st.yellow(`interrupted — ${s.pending} messages still pending; run \`donner sync\` again to continue`));
  return parts.join("\n");
}

// ─── Doctor ─────────────────────────────────────────────────────────

async function doctor(ctx) {
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, ...(fix ? { fix } : {}) });
  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node", maj > 22 || (maj === 22 && min >= 13) ? "ok" : "fail", `Node.js ${process.version}`, maj < 22 ? "Install Node.js 22 LTS or newer." : undefined);
  try {
    const { DatabaseSync } = await import("./sqlite.js");
    const d = new DatabaseSync(":memory:");
    d.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
    d.close();
    add("sqlite", "ok", "built-in SQLite with FTS5");
  } catch (err) {
    add("sqlite", "fail", err.message, "Use an official Node.js build (22.13+).");
  }
  add("config", "ok", ctx.cfg.paths.configExists ? ctx.cfg.paths.config : `defaults (no ${ctx.cfg.paths.config})`);
  add("bridge settings", isLoopbackHost(ctx.cfg.bridge.host) ? "ok" : "warn", `${ctx.cfg.bridge.host}:${ctx.cfg.bridge.port} from ${ctx.cfg.sources.bridge}${ctx.cfg.bridge.authToken ? ", with auth token" : ""}`,
    isLoopbackHost(ctx.cfg.bridge.host) ? undefined : "The bridge speaks plain HTTP; only use non-local hosts inside a trusted network (e.g. host.docker.internal).");
  const bridge = ctx.bridge();
  try {
    const s = await bridge.bridgeStatus();
    add("bridge", "ok", `tb-bridge running at ${bridge.baseUrl}`);
    if (s.extension === "connected") {
      try {
        const h = await bridge.health();
        add("thunderbird", "ok", `connected (thunderbird-cli extension ${h.version})`);
      } catch (err) {
        add("thunderbird", "fail", err.message, err.hint);
      }
    } else add("thunderbird", "fail", "Thunderbird is not connected to the bridge.", "Start Thunderbird; check that the \"Thunderbird AI Bridge\" add-on is enabled.");
  } catch (err) {
    add("bridge", "fail", err.message, err.hint);
  }
  try {
    const db = openDb(ctx.dbPath, { readOnly: true });
    const s = ops.status(db, ctx.dbPath);
    db.close();
    const age = s.last_sync_age_minutes;
    add("index", s.messages ? (age !== null && age > 24 * 60 ? "warn" : "ok") : "warn", `${s.messages} messages, last sync ${s.last_sync ? `${age} min ago` : "never"} (${ctx.dbPath})`,
      !s.messages ? "Run `donner sync`." : age > 24 * 60 ? "Run `donner sync` or set up `donner service install`." : undefined);
  } catch (err) {
    add("index", err.code === "NO_INDEX" ? "warn" : "fail", err.message, err.hint);
  }
  try {
    const db = openDb(ctx.dbPath, { readOnly: true });
    const spamLike = db
      .prepare("SELECT f.path, ac.name AS account, (SELECT count(*) FROM messages m WHERE m.folder_id = f.id) AS n FROM folders f LEFT JOIN accounts ac ON ac.id = f.account_id WHERE f.indexed = 1 AND (lower(f.name) LIKE '%spam%' OR lower(f.name) LIKE '%junk%' OR lower(f.name) LIKE '%phishing%') ORDER BY n DESC")
      .all();
    const ids = db.prepare("SELECT count(*) AS n FROM identities").get().n;
    const { suggestAddresses } = await import("./identity.js");
    const maybe = suggestAddresses(db);
    db.close();
    if (maybe.length) {
      add("my addresses", "warn", `probably yours but not configured: ${maybe.map((a) => `${a.addr} (${a.messages} mails as "${a.name}")`).join(", ")}`,
        `If they are yours, add them to the donner config (${ctx.cfg.paths.config}): "index": {"myAddresses": ${JSON.stringify(maybe.map((a) => a.addr))}} — from:me, sent/received counts, people and threads use them.`);
    }
    if (spamLike.length) {
      const labels = spamLike.slice(0, 5).map((f) => `${f.account || ""}${f.path}`);
      add("spam folders", "warn", `indexed folders whose name mentions spam or junk: ${spamLike.slice(0, 5).map((f, i) => `${labels[i]} (${f.n})`).join(", ")}`,
        `If they hold spam or spam reports you do not want to search, exclude them in the donner config (${ctx.cfg.paths.config}): "index": {"excludeFolders": ${JSON.stringify(labels)}}`);
    }
    if (!ids) add("my addresses", "warn", "no own addresses known yet", "Run `donner sync`, or list them in index.myAddresses.");
  } catch {
    // no index yet: reported above
  }
  {
    const want = ctx.cfg.index.pdftotext !== false && ctx.cfg.index.pdftotext !== "false";
    if (!want) add("pdf text", "ok", "built-in extractor (index.pdftotext: false)");
    else if (hasPdftotext()) add("pdf text", "ok", "pdftotext (poppler), built-in extractor as fallback");
    else add("pdf text", "warn", "built-in extractor only (pdftotext not installed)", "Install poppler-utils for much better PDF coverage, then run `donner sync --reparse pdf`.");
  }
  if (ctx.cfg.embeddings?.enabled) {
    try {
      const { checkEmbeddings } = await import("./semantic.js");
      add("embeddings", "ok", await checkEmbeddings(ctx.cfg));
    } catch (err) {
      add("embeddings", "warn", err.message, err.hint);
    }
  }
  return checks;
}

// ─── Help ───────────────────────────────────────────────────────────

function helpText(name, st) {
  if (name && COMMANDS[name]) {
    const c = COMMANDS[name];
    return [`${st.bold(c.usage)}`, "", c.summary + ".", c.help ? "\n" + c.help : ""].join("\n");
  }
  const groups = [
    ["Start", ["setup", "uninstall"]],
    ["Search & read", ["search", "show", "thread", "threads", "count", "people", "attachment", "sql", "schema"]],
    ["Index", ["sync", "watch", "status", "doctor", "embed", "reset"]],
    ["Integrations", ["mcp", "skill", "resolve", "service", "config"]],
  ];
  const out = [
    `${st.bold("donner")} ${PKG.version} — fast local search over your Thunderbird mail (index layer for thunderbird-cli)`,
    "",
    `${st.bold("Usage:")} donner <command> [options]`,
  ];
  for (const [title, names] of groups) {
    out.push("", st.bold(title));
    for (const n of names) out.push(`  ${fit(n, 11)} ${COMMANDS[n].summary}`);
  }
  out.push(
    "",
    st.bold("Global options"),
    "  --json        JSON output (default when not a terminal)     --human   force readable output",
    "  --pretty      indented JSON                                 --db PATH use another index file",
    "",
    st.bold("Examples"),
    '  donner sync                                   build / update the index',
    '  donner search rechnung from:stadtwerke after:2025-01',
    '  donner count has:pdf rechnung --by month',
    "  donner thread 1234",
    "",
    `Run ${st.bold("donner help <command>")} for details. Docs: https://github.com/jo-tud/donner`
  );
  return out.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function suggestCommand(name) {
  const best = Object.keys(COMMANDS)
    .map((c) => [c, levenshtein(String(name).toLowerCase(), c)])
    .sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}

/**
 * Split argv into options and positionals ourselves before parseArgs:
 *  - only exact, known flags are options; "-newsletter" or "-from:x" are query words
 *    (parseArgs would read them as clustered short flags)
 *  - global options may come before the command name
 */
export function preprocessArgs(args, options) {
  const opts = [];
  const pos = [];
  const shorts = new Map(Object.entries(options).filter(([, o]) => o.short).map(([k, o]) => ["-" + o.short, k]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    let key = null;
    if (a.startsWith("--")) {
      const name = a.slice(2).split("=")[0];
      if (name in options || (name.startsWith("no-") && name in options)) key = name;
      else {
        opts.push(a); // unknown long option: let parseArgs report it
        continue;
      }
    } else if (shorts.has(a)) key = shorts.get(a);
    if (key === null) {
      pos.push(a);
      continue;
    }
    opts.push(a);
    if (options[key].type === "string" && !a.includes("=") && i + 1 < args.length) opts.push(args[++i]);
  }
  return [...opts, "--", ...pos];
}

export async function main(argv = process.argv.slice(2)) {
  // Global options before the command: "donner --db x.sqlite search …"
  const lead = [];
  let k = 0;
  while (k < argv.length && argv[k].startsWith("--") && argv[k] !== "--help" && argv[k] !== "--version") {
    const name = argv[k].slice(2).split("=")[0];
    if (!(name in GLOBAL_OPTIONS)) break;
    lead.push(argv[k]);
    if (GLOBAL_OPTIONS[name].type === "string" && !argv[k].includes("=") && k + 1 < argv.length) lead.push(argv[++k]);
    k++;
  }
  let name = argv[k];
  let rest = [...argv.slice(k + 1), ...lead];
  if (!name || name === "--help" || name === "-h") name = "help";
  if (name === "--version" || name === "-v") name = "version";
  const cmd = COMMANDS[name];
  let jsonMode = !process.stdout.isTTY || argv.includes("--json");
  if (argv.includes("--human")) jsonMode = false;
  if (!cmd) {
    const guess = suggestCommand(name);
    printError(new DonnerError("UNKNOWN_COMMAND", `Unknown command "${name}".`, guess ? `Did you mean \`donner ${guess}\`? (\`donner help\` lists all commands)` : "Run `donner help` for the list of commands."), { json: jsonMode });
    return 2;
  }
  if (name === "help" && rest[0] && !rest[0].startsWith("-") && !COMMANDS[rest[0]]) {
    const guess = suggestCommand(rest[0]);
    printError(new DonnerError("UNKNOWN_COMMAND", `No help for unknown command "${rest[0]}".`, guess ? `Did you mean \`donner help ${guess}\`?` : "Run `donner help` for the list of commands."), { json: jsonMode });
    return 2;
  }
  let values;
  let positionals;
  const allOptions = { ...GLOBAL_OPTIONS, ...(cmd.options || {}) };
  try {
    ({ values, positionals } = parseArgs({ args: preprocessArgs(rest, allOptions), options: allOptions, allowPositionals: true, strict: true }));
  } catch (err) {
    printError(new DonnerError("INVALID_ARGS", err.message.replace(/^TypeError \[.*?\]: /, "").replace(/ To specify a positional argument.*$/, ""), `Run \`donner help ${name}\`.`), { json: jsonMode });
    return 2;
  }
  const st = makeStyle(!jsonMode && !values["no-color"] && wantColor());
  if (values.help) {
    process.stdout.write(helpText(name, st) + "\n");
    return 0;
  }

  let cfg;
  let dbs = [];
  const interrupts = [];
  let sigints = 0;
  const onSigint = () => {
    sigints++;
    if (sigints > 1 || !interrupts.length) process.exit(130);
    if (!jsonMode) process.stderr.write("\nstopping after the current batch… (Ctrl-C again to quit immediately)\n");
    for (const fn of interrupts) fn();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  try {
    cfg = loadConfig();
    const dbPath = values.db ? resolvePath(values.db) : cfg.paths.db;
    const ctx = {
      cfg,
      dbPath,
      json: jsonMode,
      st,
      out(data, human) {
        if (jsonMode) printJson(data, { pretty: values.pretty });
        else {
          const text = human();
          if (text) process.stdout.write(text + "\n");
        }
      },
      dbRO() {
        const db = openDb(dbPath, { readOnly: true });
        dbs.push(db);
        return db;
      },
      dbRW() {
        const db = openDb(dbPath);
        dbs.push(db);
        return db;
      },
      bridge() {
        return new BridgeClient(cfg.bridge);
      },
      onInterrupt(fn) {
        interrupts.push(fn);
      },
      async runSync({ full, bodies, folders, quiet, signal, reparse } = {}) {
        ensurePrivateDir(dirname(dbPath));
        const release = acquireLock(dbPath + ".lock");
        let db;
        try {
          db = openDb(dbPath);
          if (reparse) {
            const n = tx(db, () => markForReparse(db, reparse));
            if (!quiet && process.stderr.isTTY) process.stderr.write(`${n} messages will be read again\n`);
          }
        } catch (err) {
          db?.close();
          release();
          throw err;
        }
        const ac = new AbortController();
        if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
        else interrupts.push(() => ac.abort());
        const showProgress = !quiet && process.stderr.isTTY;
        let last = 0;
        const onProgress = (ev) => {
          if (!showProgress) return;
          const now = Date.now();
          if (ev.phase === "done") {
            process.stderr.write("\r\u001b[2K");
            return;
          }
          if (now - last < 100 && ev.phase === "content" && ev.done !== ev.total) return;
          last = now;
          let msg = "";
          if (ev.phase === "accounts") msg = "reading accounts and folders…";
          else if (ev.phase === "list") msg = `listing ${ev.index}/${ev.total}: ${ev.folder}`;
          else if (ev.phase === "insert") msg = `adding headers ${ev.done}/${ev.total}`;
          else if (ev.phase === "threads") msg = "re-threading conversations…";
          else if (ev.phase === "content") {
            const pct = Math.floor((ev.done / ev.total) * 100);
            const bar = "█".repeat(Math.floor(pct / 5)).padEnd(20, "░");
            msg = `indexing ${bar} ${pct}% (${ev.done}/${ev.total})`;
          } else if (ev.phase === "warn") {
            process.stderr.write(`\r\u001b[2K${st.yellow("warning")}: ${ev.folder}: ${ev.message}\n`);
            return;
          }
          process.stderr.write(`\r\u001b[2K${msg.slice(0, termWidth() - 1)}`);
        };
        try {
          return await sync({ db, bridge: new BridgeClient(cfg.bridge), cfg, full, bodies: bodies ?? cfg.index.bodies, folders, onProgress, signal: ac.signal });
        } finally {
          if (showProgress) process.stderr.write("\r\u001b[2K");
          db.close();
          release();
        }
      },
    };
    await cmd.run(ctx, values, positionals);
    return process.exitCode ?? 0;
  } catch (err) {
    if (!(err instanceof DonnerError) && !err.code) err.code = "INTERNAL";
    if (err.code === "INTERNAL" || (!(err instanceof DonnerError) && process.env.DONNER_DEBUG)) {
      err.hint = err.hint || "This looks like a bug. Please report it with DONNER_DEBUG=1 output: https://github.com/jo-tud/donner/issues";
    }
    printError(err, { json: jsonMode });
    return exitCodeFor(err);
  } finally {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
}
