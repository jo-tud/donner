// Conversation threading.
//
// Primary: References / In-Reply-To headers (and copies sharing a Message-ID).
// Fallback when a message's own references resolve to nothing (web mailers that omit them,
// replies to messages that are not in the index): the same normalised subject within ±60
// days, at least one of the two is a reply ("Re:", "AW:", …), and the two share a participant
// other than the user in reply position: the sender of one is a participant of the other. This
// keeps "Re: Frage" from two different people apart.
// A new message (not a reply) only joins replies written after it, and a thread formed this
// way spans at most 120 days.

import { normalizeSubject } from "./text.js";
import { stmt } from "./db.js";

const WINDOW = 60 * 86400000;
// A thread joined by subject may span at most this long; otherwise recurring subjects between
// the same people ("Re: Wochenbericht") would chain into one conversation over years.
const MAX_SPAN = 120 * 86400000;
// Subjects too generic to join conversations on.
const GENERIC = new Set(["hallo", "hello", "hi", "test", "frage", "question", "info", "anfrage", "termin", "danke", "thanks", "no subject", "(no subject)", "kein betreff", "(kein betreff)", "fyi", "update", "rechnung", "invoice"]);

export function isReplySubject(subject, norm) {
  const s = String(subject || "").trim().toLowerCase();
  return !!norm && norm !== s;
}

function subjectUsable(norm) {
  return !!norm && norm.length >= 4 && !GENERIC.has(norm);
}

function participantsOf(db, id, me) {
  const out = new Set();
  for (const r of stmt(db, "SELECT addr FROM addresses WHERE message_id = ? AND addr IS NOT NULL").all(id)) if (!me.has(r.addr)) out.add(r.addr);
  return out;
}

// The identities table changes once per sync; cache it briefly per connection.
const meCache = new WeakMap();
function myAddresses(db) {
  const c = meCache.get(db);
  if (c && Date.now() - c.at < 5000) return c.set;
  let set;
  try {
    set = new Set(stmt(db, "SELECT addr FROM identities").all().map((r) => r.addr));
  } catch {
    set = new Set();
  }
  meCache.set(db, { at: Date.now(), set });
  return set;
}

const unresolved = new WeakSet();

/** True (once) when messages with unresolved references were threaded since the last call. */
export function takeUnresolved(db) {
  const had = unresolved.has(db);
  unresolved.delete(db);
  return had;
}

/** The sender of one message (not the user) takes part in the other. */
function inReplyPosition(aFrom, aParts, bFrom, bParts, me) {
  if (!aParts?.size || !bParts?.size) return false;
  return (!!bFrom && !me.has(bFrom) && aParts.has(bFrom)) || (!!aFrom && !me.has(aFrom) && bParts.has(aFrom));
}

/**
 * Put one message into a thread (incremental, during sync).
 * @returns {number} thread id
 */
export function assignThread(db, id, mid, refs, subject, date) {
  const ids = new Set();
  if (refs.length) {
    const ph = refs.map(() => "?").join(",");
    const sql = `SELECT DISTINCT thread_id FROM messages INDEXED BY messages_mid WHERE mid IN (${ph}) AND thread_id IS NOT NULL`;
    for (const r of (refs.length <= 8 ? stmt(db, sql) : db.prepare(sql)).all(...refs)) ids.add(r.thread_id);
  }
  const ownRefsResolved = ids.size > 0;
  // References that point nowhere may just not be indexed yet (the first sync fetches newest
  // first). rethreadAll() at the end of the sync decides with all messages known.
  if (refs.length && !ownRefsResolved) unresolved.add(db);
  for (const r of stmt(db, "SELECT DISTINCT m.thread_id FROM refs x JOIN messages m ON m.id = x.message_id WHERE x.ref_mid = ? AND m.thread_id IS NOT NULL").all(mid)) ids.add(r.thread_id);
  for (const r of stmt(db, "SELECT DISTINCT thread_id FROM messages INDEXED BY messages_mid WHERE mid = ? AND id != ? AND thread_id IS NOT NULL").all(mid, id)) ids.add(r.thread_id);
  if (!refs.length && !ids.size && date) {
    const norm = normalizeSubject(subject).toLowerCase();
    if (subjectUsable(norm)) {
      const reply = isReplySubject(subject, norm);
      let cands = stmt(
        db,
        `SELECT id, thread_id, subject, date, from_addr FROM messages INDEXED BY messages_subject_norm
         WHERE subject_norm = ? AND id != ? AND thread_id IS NOT NULL AND date BETWEEN ? AND ?
         ORDER BY abs(date - ?) LIMIT 30`
      ).all(norm, id, date - WINDOW, date + WINDOW, date);
      // A new message only adopts later replies that have no references of their own (a reply
      // with References belongs to the message it references).
      if (!reply) cands = cands.filter((c) => c.date >= date && isReplySubject(c.subject, norm) && !stmt(db, "SELECT 1 FROM refs WHERE message_id = ? LIMIT 1").get(c.id));
      if (cands.length) {
        const me = myAddresses(db);
        const mine = participantsOf(db, id, me);
        const myFrom = stmt(db, "SELECT from_addr FROM messages WHERE id = ?").get(id)?.from_addr;
        if (mine.size) {
          // Participants of all candidates in one query.
          const theirs = new Map();
          const ph = cands.map(() => "?").join(",");
          for (const r of db.prepare(`SELECT message_id, addr FROM addresses WHERE message_id IN (${ph}) AND addr IS NOT NULL`).all(...cands.map((c) => c.id))) {
            if (me.has(r.addr)) continue;
            if (!theirs.has(r.message_id)) theirs.set(r.message_id, new Set());
            theirs.get(r.message_id).add(r.addr);
          }
          const span = stmt(db, "SELECT min(date) AS a, max(date) AS b FROM messages WHERE thread_id = ?");
          const hit = cands.find((c) => {
            if (!inReplyPosition(myFrom, mine, c.from_addr, theirs.get(c.id), me)) return false;
            const r = span.get(c.thread_id);
            return Math.max(r.b ?? date, date) - Math.min(r.a ?? date, date) <= MAX_SPAN;
          });
          if (hit) ids.add(hit.thread_id);
        }
      }
    }
  }
  const target = ids.size ? Math.min(id, ...ids) : id;
  stmt(db, "UPDATE messages SET thread_id = ? WHERE id = ?").run(target, id);
  for (const t of ids) if (t !== target) stmt(db, "UPDATE messages SET thread_id = ? WHERE thread_id = ?").run(target, t);
  return target;
}

/** Recompute all threads from scratch (after upgrades of the threading rules). */
export function rethreadAll(db) {
  const msgs = db.prepare("SELECT id, mid, subject, subject_norm, date, thread_id, from_addr FROM messages").all();
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const n = parent.get(x);
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  const lo = new Map(); // root -> earliest date
  const hi = new Map(); // root -> latest date
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const root = Math.min(ra, rb);
    const child = Math.max(ra, rb);
    parent.set(child, root);
    lo.set(root, Math.min(lo.get(ra), lo.get(rb)));
    hi.set(root, Math.max(hi.get(ra), hi.get(rb)));
  };
  const spanOk = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    return ra === rb || Math.max(hi.get(ra), hi.get(rb)) - Math.min(lo.get(ra), lo.get(rb)) <= MAX_SPAN;
  };
  const byMid = new Map();
  for (const m of msgs) {
    parent.set(m.id, m.id);
    lo.set(m.id, m.date ?? Infinity);
    hi.set(m.id, m.date ?? -Infinity);
    if (!byMid.has(m.mid)) byMid.set(m.mid, []);
    byMid.get(m.mid).push(m.id);
  }
  for (const list of byMid.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  const resolved = new Set(); // messages whose own references point at an indexed message
  for (const r of db.prepare("SELECT message_id, ref_mid FROM refs").all()) {
    const targets = byMid.get(r.ref_mid);
    if (!targets || !parent.has(r.message_id)) continue;
    resolved.add(r.message_id);
    for (const t of targets) union(r.message_id, t);
  }

  // Subject fallback for messages whose own references resolve to nothing.
  const me = myAddresses(db);
  const parts = new Map();
  for (const r of db.prepare("SELECT message_id, addr FROM addresses WHERE addr IS NOT NULL").all()) {
    if (me.has(r.addr)) continue;
    if (!parts.has(r.message_id)) parts.set(r.message_id, new Set());
    parts.get(r.message_id).add(r.addr);
  }
  const bySubject = new Map();
  for (const m of msgs) {
    if (!m.date || !subjectUsable(m.subject_norm)) continue;
    if (!bySubject.has(m.subject_norm)) bySubject.set(m.subject_norm, []);
    bySubject.get(m.subject_norm).push(m);
  }
  for (const [norm, group] of bySubject) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.date - b.date);
    for (let i = 0; i < group.length; i++) {
      const m = group[i];
      // Only messages whose own references lead nowhere. They may be referenced by their own
      // replies: a reply chain whose first message lost its parent is attached as a whole.
      if (resolved.has(m.id)) continue;
      const reply = isReplySubject(m.subject, norm);
      const mine = parts.get(m.id);
      if (!mine?.size) continue;
      // Nearest candidate within the window (the group is sorted by date).
      let best = null;
      const consider = (c) => {
        const dt = Math.abs(c.date - m.date);
        if (best && dt >= best.dt) return;
        if (!reply && (c.date < m.date || !isReplySubject(c.subject, norm) || resolved.has(c.id))) return;
        if (find(c.id) === find(m.id) || !spanOk(m.id, c.id)) return;
        if (inReplyPosition(m.from_addr, mine, c.from_addr, parts.get(c.id), me)) best = { id: c.id, dt };
      };
      for (let j = i - 1; j >= 0 && m.date - group[j].date <= WINDOW; j--) consider(group[j]);
      for (let j = i + 1; j < group.length && group[j].date - m.date <= WINDOW; j++) consider(group[j]);
      if (best) union(m.id, best.id);
    }
  }

  const upd = db.prepare("UPDATE messages SET thread_id = ? WHERE id = ?");
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const m of msgs) {
      const t = find(m.id);
      if (t !== m.thread_id) {
        upd.run(t, m.id);
        changed++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return changed;
}
