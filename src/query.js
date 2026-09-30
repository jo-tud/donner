// Gmail-style query language → SQL over the index.
//
//   rechnung stadtwerke                 all words (prefix match, umlaut-tolerant)
//   "exact phrase"                      phrase
//   angebot OR offer                    either (OR also works between filters and groups)
//   (from:anna OR to:anna) budget       grouping
//   -newsletter  -from:noreply  -(a b)  exclude
//   from:mueller to: cc: bcc: with:     participants (with: = from, to, cc or bcc); from:me / to:me
//   subject:budget body:frist           restrict words to a field
//   filename:pdf  has:attachment        attachments; has:pdf has:xlsx has:ics ...
//   has:invite has:event has:cancelled  calendar data
//   in:inbox in:sent folder:Projekte    folder type / name / path / "Account/Path"
//   account:Privat                      account name, id or address
//   is:unread is:read is:flagged is:reply is:hidden is:suspicious is:junk
//   after:2025-01 before:2025-07-01     dates (YYYY, YYYY-MM, YYYY-MM-DD, DD.MM.YYYY, today, yesterday)
//   newer_than:30d older_than:1y        relative dates (h, d, w, m, y)
//   event_after:2026-10 event_before:.. calendar invitations by event start
//   tag:$label1 list:heise thread:42    tags, mailing list, thread
//   larger:1M smaller:100K id:123 mid:  size, exact message

import { DonnerError } from "./errors.js";
import { fold, germanFold } from "./text.js";
import { ME_SQL } from "./identity.js";

const FIELD_ALIASES = {
  from: "from",
  to: "to",
  cc: "cc",
  bcc: "bcc",
  with: "with",
  subject: "subject",
  body: "body",
  filename: "filename",
  attachment: "filename",
  has: "has",
  in: "in",
  folder: "in",
  account: "account",
  is: "is",
  after: "after",
  since: "after",
  before: "before",
  until: "until",
  newer_than: "newer",
  newer: "newer",
  older_than: "older",
  older: "older",
  event_after: "event_after",
  event_before: "event_before",
  tag: "tag",
  label: "tag",
  list: "list",
  thread: "thread",
  larger: "larger",
  smaller: "smaller",
  id: "id",
  mid: "mid",
  msgid: "mid",
};

export const OPERATORS = [...new Set(Object.keys(FIELD_ALIASES))];

/** Operator reference shared by `donner help search`, the MCP tool description and tests. */
export const QUERY_HELP = `Words: all must match; prefix match (rechnung → Rechnungsnummer); umlaut-tolerant (müller = mueller, straße = strasse).
  "exact phrase"   a OR b (binds tighter than AND)   (group)   -word  -from:x  -(group)   NOT word   AND (optional)
People:  from:x to:x cc:x bcc:x with:x (from or to/cc/bcc)   from:me to:me   — name or address, umlaut/case-insensitive
Text:    subject:x body:x
Files:   filename:x has:attachment has:pdf has:docx has:xlsx has:pptx has:ics has:eml has:zip has:image
Calendar: has:invite (invitation, not cancelled) has:event (any calendar data, incl. tickets) has:cancelled
Where:   in:inbox in:sent in:drafts folder:Projekte folder:Account/Path account:Privat
Flags:   is:unread is:read is:flagged is:starred is:reply is:junk is:hidden is:suspicious is:authfail
Dates:   after:2025-01 before:2025-07-01 (exclusive)  since:2025-01 until:2025-03 (inclusive)  newer_than:30d older_than:1y  (YYYY, YYYY-MM, YYYY-MM-DD, DD.MM.YYYY, today, yesterday; units h d w m y)
Events:  event_after:2026-10 event_before:2026-11 (by event date; recurring events count while they recur); --sort event
More:    tag:$label1 label: list:heise thread:42 larger:1M smaller:100K id:123 mid:<message-id>
Tips:    German compounds match by prefix only ("suchindex" finds Suchindex, "index" does not); no stemming — try word stems (verzög).`;

const HAS_TYPES = {
  attachment: null,
  attachments: null,
  pdf: ["%.pdf", "%pdf%"],
  doc: ["%.doc%", "%msword%"],
  docx: ["%.docx", "%wordprocessingml%"],
  xls: ["%.xls%", "%excel%"],
  xlsx: ["%.xlsx", "%spreadsheetml%"],
  pptx: ["%.pptx", "%presentationml%"],
  odt: ["%.od_", "%opendocument%"],
  ics: ["%.ics", "text/calendar"],
  zip: ["%.zip", "%zip%"],
  image: ["%.png", "image/%"],
  eml: ["%.eml", "message/rfc822"],
};

const IS_FLAGS = {
  unread: "m.read = 0",
  read: "m.read = 1",
  flagged: "m.flagged = 1",
  starred: "m.flagged = 1",
  junk: "m.junk = 1",
  reply: "m.in_reply_to IS NOT NULL",
  hidden: "m.hidden_removed = 1",
  // Sender authentication failed (DMARC decides when present), or hidden content from a
  // sender that is neither authenticated by DMARC nor someone the user has written to.
  suspicious: `(m.auth_verdict = 'fail' OR (m.hidden_removed = 1 AND m.list_id IS NULL AND m.auth_verdict IS NOT 'pass'
    AND coalesce(m.from_addr, '') NOT IN (SELECT addr FROM contacts) AND coalesce(m.from_addr, '') NOT IN (SELECT addr FROM identities)))`,
  authfail: `(m.auth_verdict = 'fail')`,
};

// ─── Lexer ──────────────────────────────────────────────────────────

/**
 * Tokens: {t:"(" , neg}, {t:")"}, {t:"or"}, {t:"term", neg, field, value, quoted}
 */
const MAX_TERMS = 200;
const MAX_DEPTH = 20;

export function lex(q) {
  const s = String(q || "");
  if (s.length > 20000) throw new DonnerError("INVALID_ARGS", "The query is too long (max 20000 characters).");
  const out = [];
  let i = 0;
  let depth = 0;
  // Uppercase NOT negates what follows (a word, operator or group); uppercase AND is the
  // default anyway. Lowercase "and"/"not" stay words.
  let pendingNot = false;
  const takeNot = () => {
    const v = pendingNot;
    pendingNot = false;
    return v;
  };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || (c === "-" && s[i + 1] === "(")) {
      const neg = (c === "-") !== takeNot();
      out.push({ t: "(", neg });
      depth++;
      i += c === "-" ? 2 : 1;
      continue;
    }
    if (c === ")") {
      pendingNot = false;
      out.push({ t: ")" });
      depth--;
      i++;
      continue;
    }
    let neg = false;
    let j = i;
    if (s[j] === "-" && j + 1 < s.length && !/\s/.test(s[j + 1])) {
      neg = true;
      j++;
    }
    let field = null;
    const fm = s.slice(j).match(/^([a-zA-Z_]+):(?=\S|$)/);
    if (fm) {
      field = fm[1];
      j += fm[0].length;
    }
    let value;
    let quoted = false;
    if (field && s[j] === "(") {
      // subject:(budget planung) — a field applied to several words.
      const end = s.indexOf(")", j + 1);
      value = s.slice(j + 1, end < 0 ? s.length : end).trim();
      j = end < 0 ? s.length : end + 1;
      i = j;
      pushTerm(out, { neg: neg !== takeNot(), field, value, quoted: false });
      continue;
    }
    if (s[j] === '"') {
      const end = s.indexOf('"', j + 1);
      value = s.slice(j + 1, end < 0 ? s.length : end);
      quoted = true;
      j = end < 0 ? s.length : end + 1;
    } else {
      let k = j;
      while (k < s.length && !/\s/.test(s[k])) k++;
      value = s.slice(j, k);
      // Closing parentheses glued to a word end a group: "(from:anna OR to:anna)".
      let closes = 0;
      while (depth - closes > 0 && value.endsWith(")")) {
        value = value.slice(0, -1);
        closes++;
      }
      j = k;
      i = j;
      if (!field && !neg && (value === "AND" || value === "NOT") && !closes) {
        if (value === "NOT") pendingNot = !pendingNot;
        continue;
      }
      pushTerm(out, { neg: neg !== takeNot(), field, value, quoted, raw: s.slice(i, j) });
      for (let n = 0; n < closes; n++) {
        out.push({ t: ")" });
        depth--;
      }
      continue;
    }
    i = j;
    pushTerm(out, { neg: neg !== takeNot(), field, value, quoted });
  }
  if (out.filter((t) => t.t === "term").length > MAX_TERMS) {
    throw new DonnerError("INVALID_ARGS", `The query has too many terms (max ${MAX_TERMS}).`, "Split it into several searches, or use `donner sql`.");
  }
  return out;
}

function pushTerm(out, { neg, field, value, quoted }) {
  if (!field && !quoted && !neg && /^(OR|or|\|)$/.test(value)) {
    out.push({ t: "or" });
    return;
  }
  if (field) {
    const key = field.toLowerCase();
    if (!Object.hasOwn(FIELD_ALIASES, key)) {
      if (!value || value.startsWith("//") || field.length === 1) {
        // "Re:", "https://…", "C:\…" — a plain word, not an operator.
        if (field + ":" + value) out.push({ t: "term", neg, field: null, value: `${field}:${value}`, quoted: false });
        return;
      }
      throw new DonnerError("INVALID_ARGS", `Unknown operator "${field}:".`, `Operators: ${OPERATORS.join(", ")}. To search for the text literally, put it in quotes: "${field}:${value}".`);
    }
    if (value === "") {
      throw new DonnerError("INVALID_ARGS", `"${field}:" needs a value, e.g. ${field}:anna.`, "Write the value directly after the colon, without a space.");
    }
    out.push({ t: "term", neg, field: FIELD_ALIASES[key], value, quoted });
    return;
  }
  if (value === "" && !quoted) return;
  if (!quoted && /^[a-zA-Z_]+:$/.test(value) && Object.hasOwn(FIELD_ALIASES, value.slice(0, -1).toLowerCase())) {
    throw new DonnerError("INVALID_ARGS", `"${value}" needs a value, e.g. ${value}anna.`, "Write the value directly after the colon, without a space.");
  }
  out.push({ t: "term", neg, field: null, value, quoted });
}

/** Backwards-compatible flat token list (terms only). */
export function tokenize(q) {
  return lex(q)
    .filter((t) => t.t === "term" || t.t === "or")
    .map((t) => (t.t === "or" ? { neg: false, field: null, value: "OR", quoted: false } : { neg: t.neg, field: t.field, value: t.value, quoted: t.quoted }));
}

// ─── Parser ─────────────────────────────────────────────────────────

/**
 * AST: {k:"and"|"or", items} | {k:"not", item} | {k:"term", field, value, quoted}
 * Like Gmail, OR binds tighter than the implicit AND: "a OR b c" = (a OR b) AND c.
 */
export function parse(q) {
  const toks = lex(q);
  let p = 0;
  const peek = () => toks[p];

  function parseAnd() {
    const items = [];
    while (p < toks.length && peek().t !== ")") {
      if (peek().t === "or") throw new DonnerError("INVALID_ARGS", "OR needs something on both sides.");
      items.push(parseOr());
    }
    if (!items.length) throw new DonnerError("INVALID_ARGS", "Empty group in the query.");
    return items.length === 1 ? items[0] : { k: "and", items };
  }
  function parseOr() {
    const items = [parseUnary()];
    while (peek()?.t === "or") {
      p++;
      if (!peek() || peek().t === ")" || peek().t === "or") throw new DonnerError("INVALID_ARGS", "OR needs something on both sides.");
      items.push(parseUnary());
    }
    return items.length === 1 ? items[0] : { k: "or", items };
  }
  let depth = 0;
  function parseUnary() {
    const tok = toks[p++];
    if (tok.t === "(") {
      if (++depth > MAX_DEPTH) throw new DonnerError("INVALID_ARGS", `Groups are nested too deeply (max ${MAX_DEPTH}).`);
      const inner = peek() && peek().t !== ")" ? parseAnd() : null;
      depth--;
      if (peek()?.t === ")") p++;
      if (!inner) throw new DonnerError("INVALID_ARGS", "Empty parentheses in the query.");
      return tok.neg ? { k: "not", item: inner } : inner;
    }
    if (tok.t === ")") throw new DonnerError("INVALID_ARGS", "Unbalanced parentheses in the query.", 'Remove the extra ")" or quote it.');
    const node = { k: "term", field: tok.field, value: tok.value, quoted: tok.quoted };
    return tok.neg ? { k: "not", item: node } : node;
  }

  if (!toks.length) return null;
  const ast = parseAnd();
  if (p < toks.length) throw new DonnerError("INVALID_ARGS", "Unbalanced parentheses in the query.", 'Remove the extra ")" or quote it.');
  return ast;
}

// ─── Dates, sizes ───────────────────────────────────────────────────

function validDate(y, mo, d = 1) {
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt.getTime() : null;
}

/** Parse dates like 2025, 2025-03, 2025-03-14, 14.03.2025, today, yesterday, 7d → unix ms. */
export function parseDateStart(s, now = Date.now()) {
  const v = String(s).trim().toLowerCase();
  if (v === "today" || v === "heute") return startOfDay(now);
  if (v === "yesterday" || v === "gestern") return startOfDay(now) - 86400000;
  const rel = parseRelative(v, now);
  if (rel !== null) return rel;
  let m;
  let t = null;
  // Calendar dates are interpreted in the local time zone, like the user reads them.
  if ((m = v.match(/^(\d{4})$/))) t = validDate(+m[1], 1);
  else if ((m = v.match(/^(\d{4})[-/](\d{1,2})$/))) t = validDate(+m[1], +m[2]);
  else if ((m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) t = validDate(+m[1], +m[2], +m[3]);
  else if ((m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) t = validDate(+m[3], +m[2], +m[1]);
  else if (/^\d{4}-\d{2}-\d{2}t/.test(v) && !Number.isNaN(Date.parse(s))) t = Date.parse(s);
  if (t !== null) return t;
  throw new DonnerError("INVALID_ARGS", `Cannot understand the date "${s}".`, "Use YYYY, YYYY-MM, YYYY-MM-DD, DD.MM.YYYY, today, yesterday or 7d / 2w / 3m / 1y.");
}

/** before:X is exclusive, like Gmail: before:2025-07 means "earlier than 1 July 2025". */
export function parseDateEnd(s, now = Date.now()) {
  return parseDateStart(s, now);
}

/**
 * until:X is inclusive: the end of the named year, month or day. since:2025-01 until:2025-01
 * is all of January 2025. Relative values and timestamps are a point in time.
 */
export function parseDateUntil(s, now = Date.now()) {
  const v = String(s).trim().toLowerCase();
  const start = parseDateStart(s, now);
  let m;
  if (v === "today" || v === "heute" || v === "yesterday" || v === "gestern") return nextDay(start);
  if (/^\d{4}$/.test(v)) return new Date(new Date(start).getFullYear() + 1, 0, 1).getTime();
  if ((m = v.match(/^(\d{4})[-/](\d{1,2})$/))) return new Date(+m[1], +m[2], 1).getTime();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v) || /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(v)) return nextDay(start);
  return start + 1;
}

function nextDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function parseRelative(v, now = Date.now()) {
  const m = String(v).trim().toLowerCase().match(/^(\d+)\s*(h|d|w|m|mo|y)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, mo: 30 * 86400e3, y: 365 * 86400e3 }[m[2]];
  return now - n * unit;
}

function parseSize(v) {
  const m = String(v).trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/);
  if (!m) throw new DonnerError("INVALID_ARGS", `Cannot understand the size "${v}".`, "Use e.g. 500K, 2M.");
  return Math.round(Number(m[1]) * { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]]);
}

// ─── FTS terms ──────────────────────────────────────────────────────

function ftsEscape(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/** Spelling variants for German: ü ↔ ue, ß ↔ ss (the index folds diacritics, not ß). */
export function wordVariants(word) {
  // The index stores ä/ö/ü/ß as ae/oe/ue/ss; queries use the same form.
  return [germanFold(word.trim().toLowerCase())];
}

/** One FTS term, prefix-matched, with German transliteration variants. */
export function ftsTerm(word, { prefix = true } = {}) {
  const w = word.trim();
  if (!w) return null;
  const parts = wordVariants(w)
    .map((v) => {
      // FTS5 tokenises on punctuation; "anna@example.com" becomes a phrase of tokens.
      const tokens = v.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (!tokens.length) return null;
      if (tokens.length === 1) return ftsEscape(tokens[0]) + (prefix ? "*" : "");
      return ftsEscape(tokens.join(" "));
    })
    .filter(Boolean);
  const uniq = [...new Set(parts)];
  if (!uniq.length) return null;
  return uniq.length === 1 ? uniq[0] : `(${uniq.join(" OR ")})`;
}

function ftsPhrase(text) {
  const tokens = germanFold(String(text).toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return null;
  return ftsEscape(tokens.join(" "));
}

function ftsFor(node) {
  if (node.field === "subject" || node.field === "body") {
    const inner = node.quoted ? ftsPhrase(node.value) : node.value.split(/\s+/).map((w) => ftsTerm(w)).filter(Boolean).join(" AND ");
    return inner ? `${node.field} : (${inner})` : null;
  }
  return node.quoted ? ftsPhrase(node.value) : ftsTerm(node.value);
}

function isWord(node) {
  return node.k === "term" && (!node.field || node.field === "subject" || node.field === "body");
}

// ─── Filters ────────────────────────────────────────────────────────

const like = (v) => `%${String(v).replace(/[\\%_]/g, "\\$&")}%`;
const ME = ME_SQL;

function participant(roles, v) {
  if (v.toLowerCase() === "me") {
    // Driven by the address index: few addresses, many messages.
    return { sql: `m.id IN (SELECT ad.message_id FROM addresses ad WHERE ad.addr IN ${ME} AND ad.role IN (${roles}))`, params: [] };
  }
  return { sql: `EXISTS (SELECT 1 FROM addresses ad WHERE ad.message_id = m.id AND ad.role IN (${roles}) AND ad.fold LIKE ? ESCAPE '\\')`, params: [like(fold(v))] };
}

function filterSql(field, v, now) {
  switch (field) {
    case "from":
      // Spam forging one of my addresses fails authentication and is not "from me".
      if (v.toLowerCase() === "me") return { sql: `(m.from_addr IN ${ME} AND m.auth_verdict IS NOT 'fail')`, params: [] };
      return { sql: "m.from_fold LIKE ? ESCAPE '\\'", params: [like(fold(v))] };
    case "to":
      return participant("'to','cc','bcc'", v);
    case "cc":
      return participant("'cc'", v);
    case "bcc":
      return participant("'bcc'", v);
    case "with":
      return participant("'from','to','cc','bcc'", v);
    case "filename":
      return { sql: "EXISTS (SELECT 1 FROM attachments at WHERE at.message_id = m.id AND (at.filename LIKE ? ESCAPE '\\' OR at.content_type LIKE ? ESCAPE '\\'))", params: [like(v), like(v)] };
    case "has": {
      const k = v.toLowerCase();
      // invite: a real invitation (METHOD:REQUEST, not cancelled). event/calendar: any calendar
      // data (tickets and bookings are usually METHOD:PUBLISH). cancelled: cancellations.
      if (k === "invite" || k === "invitation") {
        return { sql: "EXISTS (SELECT 1 FROM events ev WHERE ev.message_id = m.id AND ev.method = 'REQUEST' AND ev.active = 1)", params: [] };
      }
      if (k === "event" || k === "calendar") return { sql: "EXISTS (SELECT 1 FROM events ev WHERE ev.message_id = m.id)", params: [] };
      if (k === "cancelled" || k === "canceled" || k === "cancellation") {
        return { sql: "EXISTS (SELECT 1 FROM events ev WHERE ev.message_id = m.id AND (ev.method = 'CANCEL' OR ev.status = 'CANCELLED'))", params: [] };
      }
      if (!Object.hasOwn(HAS_TYPES, k)) throw new DonnerError("INVALID_ARGS", `Unknown has:${v}.`, `Use has:${[...Object.keys(HAS_TYPES), "invite", "event", "cancelled"].join(", has:")}.`);
      if (!HAS_TYPES[k]) return { sql: "m.attachment_count > 0", params: [] };
      const [name, type] = HAS_TYPES[k];
      return { sql: "EXISTS (SELECT 1 FROM attachments at WHERE at.message_id = m.id AND (lower(at.filename) LIKE ? OR at.content_type LIKE ?))", params: [name, type] };
    }
    case "in":
      return {
        sql: "(f.type = ? OR f.path LIKE ? ESCAPE '\\' OR f.name LIKE ? ESCAPE '\\' OR m.folder_id = ? OR (coalesce(ac.name, '') || f.path) LIKE ? ESCAPE '\\')",
        params: [v.toLowerCase(), like(v), like(v), v, like(v)],
      };
    case "account":
      return { sql: "(m.account_id = ? OR ac.name LIKE ? ESCAPE '\\' OR ac.email LIKE ? ESCAPE '\\')", params: [v, like(v), like(v)] };
    case "is": {
      const k = v.toLowerCase();
      if (!Object.hasOwn(IS_FLAGS, k)) throw new DonnerError("INVALID_ARGS", `Unknown is:${v}.`, `Use is:${Object.keys(IS_FLAGS).join(", is:")}.`);
      return { sql: IS_FLAGS[k], params: [] };
    }
    case "after":
      return { sql: "m.date >= ?", params: [parseDateStart(v, now)] };
    case "until":
      return { sql: "m.date < ?", params: [parseDateUntil(v, now)] };
    case "before":
      return { sql: "m.date < ?", params: [parseDateEnd(v, now)] };
    case "newer":
    case "older": {
      const r = parseRelative(v, now);
      if (r === null) throw new DonnerError("INVALID_ARGS", `${field === "newer" ? "newer_than" : "older_than"} needs a relative time like 7d, 2w, 3m or 1y, got "${v}".`);
      return { sql: field === "newer" ? "m.date >= ?" : "m.date < ?", params: [r] };
    }
    case "event_after":
      // Only the current version of an event, not cancelled; series count while they recur.
      return { sql: "EXISTS (SELECT 1 FROM events ev WHERE ev.message_id = m.id AND ev.active = 1 AND coalesce(ev.last_start, ev.start) >= ?)", params: [parseDateStart(v, now)] };
    case "event_before":
      return { sql: "EXISTS (SELECT 1 FROM events ev WHERE ev.message_id = m.id AND ev.active = 1 AND ev.start < ?)", params: [parseDateEnd(v, now)] };
    case "tag":
      return { sql: "m.tags LIKE ? ESCAPE '\\'", params: [like(`"${v}"`)] };
    case "list":
      return { sql: "m.list_id LIKE ? ESCAPE '\\'", params: [like(v)] };
    case "thread":
      return { sql: "m.thread_id = ?", params: [intArg(v, "thread")] };
    case "id":
      return { sql: "m.id = ?", params: [intArg(v, "id")] };
    case "mid":
      return { sql: "m.mid = ?", params: [v.replace(/^<|>$/g, "")] };
    case "larger":
      return { sql: "m.size > ?", params: [parseSize(v)] };
    case "smaller":
      return { sql: "m.size < ?", params: [parseSize(v)] };
    default:
      throw new DonnerError("INVALID_ARGS", `Unsupported operator ${field}:`);
  }
}

function intArg(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new DonnerError("INVALID_ARGS", `${name} must be a number, got "${v}".`);
  return n;
}

// ─── Compiler ───────────────────────────────────────────────────────

/** SQL predicate for any AST node (used inside OR / NOT, where MATCH cannot be used directly). */
function predicate(node, now) {
  switch (node.k) {
    case "and":
    case "or": {
      const parts = node.items.map((n) => predicate(n, now));
      return { sql: `(${parts.map((p) => p.sql).join(node.k === "and" ? " AND " : " OR ")})`, params: parts.flatMap((p) => p.params) };
    }
    case "not": {
      const inner = predicate(node.item, now);
      // COALESCE: NULL columns (e.g. folders without a type) must count as "not matching".
      return { sql: `NOT COALESCE((${inner.sql}), 0)`, params: inner.params };
    }
    default: {
      if (isWord(node)) {
        const expr = ftsFor(node);
        if (!expr) return { sql: "1", params: [] };
        return { sql: "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)", params: [expr] };
      }
      return filterSql(node.field, node.value, now);
    }
  }
}

/**
 * Compile a query string (plus structured filters from CLI flags / MCP) into SQL pieces.
 * Top-level positive words form one FTS MATCH (for bm25 ranking); everything else becomes
 * parameterised predicates.
 * @returns {{match: string|null, where: string[], params: any[], hasText: boolean}}
 */
/** Remove word terms that contain no searchable characters (e.g. -"!"), and empty groups. */
function prune(node) {
  if (!node) return null;
  if (node.k === "term") return isWord(node) && !ftsFor(node) ? null : node;
  if (node.k === "not") {
    const item = prune(node.item);
    return item ? { k: "not", item } : null;
  }
  const items = node.items.map(prune).filter(Boolean);
  if (!items.length) return null;
  return items.length === 1 ? items[0] : { k: node.k, items };
}

/** Top-level conjuncts that can go into the ranked FTS MATCH (positive words, OR of words). */
function isMatchable(c) {
  return isWord(c) || (c.k === "or" && c.items.every(isWord));
}

export function compileQuery(q, extra = {}, now = Date.now()) {
  const ast = prune(parse(q));
  const where = [];
  const params = [];
  const match = [];
  const conjuncts = !ast ? [] : ast.k === "and" ? ast.items : [ast];
  for (const c of conjuncts) {
    if (isWord(c)) {
      match.push(ftsFor(c));
      continue;
    }
    if (c.k === "or" && c.items.every(isWord)) {
      const parts = c.items.map(ftsFor);
      match.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
      continue;
    }
    const p = predicate(c, now);
    where.push(p.sql);
    params.push(...p.params);
  }

  const add = (field, value) => {
    const p = filterSql(field, value, now);
    where.push(p.sql);
    params.push(...p.params);
  };
  if (extra.from) add("from", extra.from);
  if (extra.to) add("to", extra.to);
  if (extra.folder) add("in", extra.folder);
  if (extra.account) add("account", extra.account);
  if (extra.since) add("after", extra.since);
  if (extra.until) add("until", extra.until);
  if (extra.unread) add("is", "unread");
  if (extra.flagged) add("is", "flagged");
  if (extra.hasAttachment) add("has", "attachment");
  if (extra.thread !== undefined && extra.thread !== null) add("thread", extra.thread);

  return { match: match.length ? match.join(" AND ") : null, where, params, hasText: match.length > 0 };
}

/** The free words of a query (positive, top-level) — the text for semantic search. */
export function freeText(q) {
  const ast = prune(parse(q));
  const conjuncts = !ast ? [] : ast.k === "and" ? ast.items : [ast];
  const words = [];
  for (const c of conjuncts) {
    if (!isMatchable(c)) continue;
    for (const t of c.k === "or" ? c.items : [c]) if (!t.field) words.push(t.value);
  }
  return words.join(" ").trim();
}

function serialize(node) {
  if (node.k === "term") {
    const v = node.value;
    const val = node.field && /\s/.test(v) && (node.field === "subject" || node.field === "body") && !node.quoted ? `(${v})` : node.quoted || /\s/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
    return `${node.field ? node.field + ":" : ""}${val}`;
  }
  if (node.k === "not") return node.item.k === "term" ? `-${serialize(node.item)}` : `-(${serialize(node.item)})`;
  if (node.k === "or") return `(${node.items.map(serialize).join(" OR ")})`;
  return node.items.map((n) => (n.k === "and" ? `(${serialize(n)})` : serialize(n))).join(" ");
}

/** The query without its ranked free words (filters, exclusions, groups keep their meaning). */
export function operatorsOnly(q) {
  const ast = prune(parse(q));
  const conjuncts = !ast ? [] : ast.k === "and" ? ast.items : [ast];
  return conjuncts
    .filter((c) => !isMatchable(c) || (c.k === "term" && c.field))
    .map(serialize)
    .join(" ");
}
