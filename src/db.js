// SQLite schema and connection handling.

import { existsSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";
import { DatabaseSync } from "./sqlite.js";
import { ensurePrivateDir } from "./config.js";
import { DonnerError } from "./errors.js";
import { germanFold, fold } from "./text.js";
import { authVerdict, refreshIdentities, refreshContacts } from "./identity.js";
import { refreshEvents } from "./calendar.js";

export const SCHEMA_VERSION = 4;

// Column weights for bm25(): subject, people, body, quoted, att_text.
export const FTS_WEIGHTS = [6.0, 3.0, 1.0, 0.15, 0.8];

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,   -- Thunderbird account id, e.g. "account1"
  name       TEXT,
  type       TEXT,               -- imap | pop3 | none | ...
  email      TEXT,               -- primary identity address
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS folders (
  id            TEXT PRIMARY KEY,  -- Thunderbird folder id, e.g. "account1://INBOX"
  account_id    TEXT,
  path          TEXT,
  name          TEXT,
  type          TEXT,              -- inbox | sent | drafts | archives | junk | trash | ... | NULL
  total         INTEGER,           -- message count reported by Thunderbird
  unread        INTEGER,
  indexed       INTEGER NOT NULL DEFAULT 1,  -- 0 = excluded by configuration
  synced_at     INTEGER,           -- last time this folder was listed (unix ms)
  reconciled_at INTEGER,           -- last full listing (unix ms)
  sync_total    INTEGER,           -- total/unread as seen at the last listing
  sync_unread   INTEGER,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,   -- donner id: stable across Thunderbird restarts
  mid             TEXT NOT NULL,         -- RFC 5322 Message-ID without angle brackets
  folder_id       TEXT NOT NULL,
  account_id      TEXT,
  tb_id           INTEGER,               -- last known thunderbird-cli message id (session scoped!)
  tb_epoch        INTEGER,
  date            INTEGER,               -- unix ms
  from_name       TEXT,
  from_addr       TEXT,                  -- lowercased
  from_fold       TEXT,                  -- folded name + address for tolerant matching
  to_json         TEXT,                  -- JSON [{name, addr}]
  cc_json         TEXT,
  bcc_json        TEXT,
  reply_to        TEXT,
  subject         TEXT,
  subject_norm    TEXT,                  -- lowercased subject without Re:/AW:/Fwd: prefixes
  thread_id       INTEGER,
  in_reply_to     TEXT,
  list_id         TEXT,
  size            INTEGER,
  read            INTEGER,
  flagged         INTEGER,
  junk            INTEGER,
  tags            TEXT,                  -- JSON array of tag keys
  attachment_count INTEGER NOT NULL DEFAULT 0,
  body            TEXT,                  -- the message's own text (quotes/signature removed)
  quoted          TEXT,                  -- quoted history and signature
  snippet         TEXT,
  people          TEXT,                  -- names + addresses, for full-text search
  att_text        TEXT,                  -- attachment names + extracted text, for full-text search
  content_state   TEXT NOT NULL DEFAULT 'pending', -- pending | full | parts | headers | error
  content_error   TEXT,
  auth_json       TEXT,                  -- {"spf":"pass","dkim":"pass","dmarc":"pass"}
  hidden_removed  INTEGER NOT NULL DEFAULT 0, -- hidden HTML content was stripped
  indexed_at      INTEGER,
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS messages_mid ON messages(mid);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder_id, date);
CREATE INDEX IF NOT EXISTS messages_date ON messages(date);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, date);
CREATE INDEX IF NOT EXISTS messages_from ON messages(from_addr);
CREATE INDEX IF NOT EXISTS messages_state ON messages(content_state);
CREATE INDEX IF NOT EXISTS messages_subject_norm ON messages(subject_norm, date);

CREATE TABLE IF NOT EXISTS refs (          -- References + In-Reply-To, for threading
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ref_mid    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_ref ON refs(ref_mid);
CREATE INDEX IF NOT EXISTS refs_msg ON refs(message_id);

CREATE TABLE IF NOT EXISTS addresses (     -- one row per participant, for aggregation
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                -- from | to | cc | bcc | reply-to
  name       TEXT,
  addr       TEXT,                         -- lowercased
  fold       TEXT                          -- folded name + address for tolerant matching
);
CREATE INDEX IF NOT EXISTS addresses_addr ON addresses(addr, role);
CREATE INDEX IF NOT EXISTS addresses_msg ON addresses(message_id);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,           -- 1-based position within the message
  part_name    TEXT,                       -- MIME part name for "tb attachment-download"
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  text         TEXT,                       -- extracted text (may be truncated)
  text_state   TEXT                        -- extracted | truncated | unsupported | too_large | error | skipped
);
CREATE INDEX IF NOT EXISTS attachments_msg ON attachments(message_id);

CREATE TABLE IF NOT EXISTS events (       -- calendar invitations found in .ics parts
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  start      INTEGER,                      -- unix ms
  end        INTEGER,
  summary    TEXT,
  location   TEXT,
  organizer  TEXT
);
CREATE INDEX IF NOT EXISTS events_msg ON events(message_id);
CREATE INDEX IF NOT EXISTS events_start ON events(start);

CREATE TABLE IF NOT EXISTS embeddings (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,                -- float32 little endian, L2-normalised
  created_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, people, body, quoted, att_text,
  content='messages', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2",
  prefix='2 3 4'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text)
  VALUES (new.id, new.subject, new.people, new.body, new.quoted, new.att_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, people, body, quoted, att_text)
  VALUES ('delete', old.id, old.subject, old.people, old.body, old.quoted, old.att_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF subject, people, body, quoted, att_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, people, body, quoted, att_text)
  VALUES ('delete', old.id, old.subject, old.people, old.body, old.quoted, old.att_text);
  INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text)
  VALUES (new.id, new.subject, new.people, new.body, new.quoted, new.att_text);
END;

-- Friendly view for ad-hoc SQL: readable dates, folder and account names.
CREATE VIEW IF NOT EXISTS mail AS
SELECT m.id,
       strftime('%Y-%m-%dT%H:%M:%SZ', m.date / 1000, 'unixepoch') AS date,
       m.from_name, m.from_addr, m.subject,
       f.path AS folder, f.type AS folder_type, a.name AS account,
       m.thread_id, m.read, m.flagged, m.tags, m.attachment_count, m.size,
       m.snippet, m.list_id, m.mid
FROM messages m
LEFT JOIN folders f ON f.id = m.folder_id
LEFT JOIN accounts a ON a.id = m.account_id;
`;

// Schema 2: several addresses per user, contacts, DMARC-based verdict, richer calendar data,
// German transliteration in the full-text index (ä→ae, via donner_de()).
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS identities (    -- the user's own addresses
  addr       TEXT PRIMARY KEY,             -- lowercased
  name       TEXT,
  source     TEXT NOT NULL,                -- account | config | sent (sender in a sent folder)
  account_id TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS contacts (      -- addresses the user has written to
  addr      TEXT PRIMARY KEY,
  sent      INTEGER,                       -- messages the user sent to this address
  last_sent INTEGER
) WITHOUT ROWID;

ALTER TABLE messages ADD COLUMN auth_verdict TEXT;   -- pass | fail | NULL (DMARC decides)
ALTER TABLE events ADD COLUMN method TEXT;           -- REQUEST | CANCEL | PUBLISH | REPLY | ...
ALTER TABLE events ADD COLUMN status TEXT;           -- CONFIRMED | TENTATIVE | CANCELLED
ALTER TABLE events ADD COLUMN rrule TEXT;            -- recurrence rule, e.g. FREQ=WEEKLY;BYDAY=MO
ALTER TABLE events ADD COLUMN uid TEXT;
ALTER TABLE events ADD COLUMN last_start INTEGER;    -- last occurrence of a recurring event (far future = open-ended)
CREATE INDEX IF NOT EXISTS events_last ON events(last_start);

DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text)
  VALUES (new.id, donner_de(new.subject), donner_de(new.people), donner_de(new.body), donner_de(new.quoted), donner_de(new.att_text));
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, people, body, quoted, att_text)
  VALUES ('delete', old.id, donner_de(old.subject), donner_de(old.people), donner_de(old.body), donner_de(old.quoted), donner_de(old.att_text));
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF subject, people, body, quoted, att_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, people, body, quoted, att_text)
  VALUES ('delete', old.id, donner_de(old.subject), donner_de(old.people), donner_de(old.body), donner_de(old.quoted), donner_de(old.att_text));
  INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text)
  VALUES (new.id, donner_de(new.subject), donner_de(new.people), donner_de(new.body), donner_de(new.quoted), donner_de(new.att_text));
END;
`;

// Messages whose stored content was produced by extraction code that has since improved.
// They are fetched again by the next sync (old content stays searchable until then).
export const REPARSE_SETS = {
  hidden: "m.hidden_removed = 1",
  empty: "coalesce(m.body, '') = '' AND coalesce(m.quoted, '') = ''",
  attachments: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.text_state IN ('no_text','too_large','error','empty'))",
  pdf: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND (lower(a.filename) LIKE '%.pdf' OR a.content_type = 'application/pdf') AND a.text_state IN ('no_text','error','too_large'))",
  calendar: "(EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id) OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND (lower(a.filename) LIKE '%.ics' OR a.content_type LIKE 'text/calendar%')))",
  headers: "(m.subject LIKE '%\uFFFD%' OR m.subject LIKE '%=?%?=%' OR m.from_name LIKE '%\uFFFD%' OR m.from_name LIKE '%=?%?=%')",
  auth: "(m.auth_json IS NOT NULL AND (m.auth_json NOT LIKE '%\"dmarc\"%' OR m.auth_json NOT LIKE '%\"spf\"%'))",
  replies: "(coalesce(m.body, '') = '' AND coalesce(m.quoted, '') != '')",
  large: "m.content_state = 'parts'",
  all: "1",
};

/** Mark messages for re-extraction. @returns number of messages marked. */
export function markForReparse(db, sets) {
  const conds = sets.map((k) => {
    if (!Object.hasOwn(REPARSE_SETS, k)) throw new DonnerError("INVALID_ARGS", `Unknown reparse set "${k}".`, `Use one or more of: ${Object.keys(REPARSE_SETS).join(", ")}.`);
    return REPARSE_SETS[k];
  });
  if (!conds.length) return 0;
  return Number(
    db.prepare(`UPDATE messages AS m SET content_state = 'pending' WHERE m.content_state IN ('full','parts') AND (${conds.join(" OR ")})`).run().changes
  );
}

/** SQL functions the schema needs (FTS triggers) or migrations use. */
function registerFunctions(db) {
  db.function("donner_de", { deterministic: true }, (s) => (typeof s === "string" ? germanFold(s) : s));
  db.function("donner_fold", { deterministic: true }, (s) => fold(s));
}

function secureFile(path) {
  if (platform() === "win32") return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) chmodSync(path, 0o600);
  } catch {
    // file does not exist yet
  }
}

/**
 * Open (and if needed create) the index database.
 * @param {string} path
 * @param {{readOnly?: boolean}} opts
 */
export function openDb(path, { readOnly = false } = {}) {
  if (path !== ":memory:") {
    if (!existsSync(path)) {
      if (readOnly) {
        throw new DonnerError("NO_INDEX", `No index found at ${path}.`, "Run `donner sync` first to build the index.");
      }
      ensurePrivateDir(dirname(path));
      // Pre-create with 0600 so SQLite (and its -wal/-shm files) inherit private permissions.
      writeFileSync(path, "", { mode: 0o600 });
    }
    secureFile(path);
  }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
  } catch (err) {
    throw new DonnerError("DB_ERROR", `Cannot open index ${path}: ${err.message}`);
  }
  db.exec("PRAGMA busy_timeout = 10000");
  // SQLite's default page cache is 2 MB; aggregations over a mailbox-sized index (people,
  // count) re-read hundreds of MB through it. A 64 MB cache and memory-mapped reads make
  // them markedly faster; mapped pages are file-backed and reclaimable.
  db.exec("PRAGMA cache_size = -65536");
  if (path !== ":memory:") db.exec("PRAGMA mmap_size = 536870912");
  registerFunctions(db);
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);
    for (const suffix of ["-wal", "-shm"]) secureFile(path + suffix);
  } else {
    const v = getMetaSafe(db, "schema_version");
    if (v === null) {
      db.close();
      throw new DonnerError("NO_INDEX", `The index at ${path} is empty.`, "Run `donner sync` first to build the index.");
    }
    if (Number(v) > SCHEMA_VERSION) {
      db.close();
      throw new DonnerError("SCHEMA_TOO_NEW", `The index was created by a newer donner (schema ${v}).`, "Upgrade donner.");
    }
    if (Number(v) < SCHEMA_VERSION && path !== ":memory:") {
      // Index from an older donner: upgrade it once through a writable connection.
      db.close();
      try {
        openDb(path).close();
      } catch (err) {
        if (err instanceof DonnerError) throw err;
        throw new DonnerError("DB_BUSY", `The index needs a one-time upgrade but is busy (${err.message}).`, "Stop other donner processes (MCP server, service), then run `donner sync`.");
      }
      return openDb(path, { readOnly: true });
    }
  }
  return db;
}

function migrate(db) {
  const current = Number(getMetaSafe(db, "schema_version") ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new DonnerError("SCHEMA_TOO_NEW", `The index was created by a newer donner (schema ${current}).`, "Upgrade donner.");
  }
  if (current >= SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have upgraded while we waited for the write lock.
    const v = Number(getMetaSafe(db, "schema_version") ?? 0);
    if (v < 1) {
      db.exec(SCHEMA_V1);
      setMeta(db, "created_at", String(Date.now()));
      if (getMeta(db, "tb_epoch") === null) setMeta(db, "tb_epoch", "1");
    }
    if (v < 2) db.exec(SCHEMA_V2);
    if (v < 3) {
      // Thunderbird's identity id (e.g. "id2"): thunderbird-cli's compose needs it as "from".
      db.exec("ALTER TABLE identities ADD COLUMN tb_identity TEXT");
    }
    if (v < 4) {
      // Calendar versions: only the newest version of an event counts (SEQUENCE,
      // RECURRENCE-ID), cancellations apply, open-ended series are bounded.
      db.exec(`
        ALTER TABLE events ADD COLUMN sequence INTEGER;
        ALTER TABLE events ADD COLUMN recurrence_id TEXT;
        ALTER TABLE events ADD COLUMN parsed_last INTEGER;
        ALTER TABLE events ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE events ADD COLUMN next_start INTEGER;
        UPDATE events SET parsed_last = last_start;
        CREATE INDEX IF NOT EXISTS events_uid ON events(uid);
      `);
    }
    if (v >= 1 && v < 2) upgradeToV2(db);
    if (v >= 1 && v < 4) upgradeToV4(db, v);
    setMeta(db, "schema_version", String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Data changes for indexes created before schema 4. */
function upgradeToV4(db, from) {
  if (from >= 2) {
    // Re-read what 0.2 handled poorly: calendar versions, dmarc-only Authentication-Results,
    // bodies lost to unclosed <head>, bottom-posted replies filed as quotes.
    markForReparse(db, ["calendar", "auth", "empty", "replies"]);
  }
  refreshEvents(db);
  setMeta(db, "rethread", "1"); // reply chains whose first message lost its parent
}

/** Data changes for indexes created by donner 0.1.x. */
function upgradeToV2(db) {
  const n = db.prepare("SELECT count(*) AS n FROM messages").get().n;
  if (n > 2000 && !process.env.DONNER_QUIET_MIGRATION) {
    process.stderr.write(`donner: upgrading the index (${n} messages, one-time, may take a minute)…\n`);
  }
  // Full-text index with German transliteration. ('rebuild' would read the raw columns.)
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('delete-all')");
  db.exec(
    `INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text)
     SELECT id, donner_de(subject), donner_de(people), donner_de(body), donner_de(quoted), donner_de(att_text) FROM messages`
  );
  // Tolerant name matching: ä→ae instead of ae→a.
  db.exec("UPDATE messages SET from_fold = donner_fold(coalesce(from_name, '') || ' ' || coalesce(from_addr, ''))");
  db.exec("UPDATE addresses SET fold = donner_fold(coalesce(name, '') || ' ' || coalesce(addr, ''))");
  // Sender-authentication verdict from the stored results.
  const upd = db.prepare("UPDATE messages SET auth_verdict = ? WHERE id = ?");
  for (const r of db.prepare("SELECT id, auth_json FROM messages WHERE auth_json IS NOT NULL").all()) {
    let auth = null;
    try {
      auth = JSON.parse(r.auth_json);
    } catch {
      // ignore
    }
    const v = authVerdict(auth);
    if (v) upd.run(v, r.id);
  }
  refreshIdentities(db);
  refreshContacts(db);
  // Re-extract what earlier versions got wrong (MJML text, PDFs, calendar data, 8-bit
  // headers, split Authentication-Results headers, attachments of large messages).
  const marked = markForReparse(db, ["hidden", "empty", "attachments", "calendar", "headers", "auth", "large", "replies"]);
  setMeta(db, "rethread", "1");
  if (n > 2000 && !process.env.DONNER_QUIET_MIGRATION) {
    process.stderr.write(`donner: index upgraded; ${marked} messages will be re-read from Thunderbird by the next sync.\n`);
  }
}

function getMetaSafe(db, key) {
  try {
    return getMeta(db, key);
  } catch {
    return null;
  }
}

export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value === null || value === undefined ? null : String(value)
  );
}

// Prepared statements per connection. Preparing costs more than running most of the small
// statements in the sync hot path, so they are reused.
const STMTS = new WeakMap();
export function stmt(db, sql) {
  let m = STMTS.get(db);
  if (!m) STMTS.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) {
    st = db.prepare(sql);
    m.set(sql, st);
  }
  return st;
}

/** Run fn inside a transaction. */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw err;
  }
}
