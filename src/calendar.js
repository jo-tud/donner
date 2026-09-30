// Calendar state across messages.
//
// Invitations arrive as a series of messages: the first REQUEST, updates with a higher
// SEQUENCE, per-occurrence changes (RECURRENCE-ID) and cancellations. Only the newest version
// of each event counts; a cancelled event is not upcoming; a series without an end is assumed
// to run for a year after its newest message (otherwise every weekly meeting ever received
// would stay "upcoming" forever). Recomputed at the end of every sync.

const DAY = 86400000;
const NOT_VERSIONS = new Set(["REPLY", "COUNTER", "DECLINECOUNTER", "REFRESH"]);
export const OPEN_END = 365 * DAY;
export const FOREVER = 8.64e15;

function parseRule(rrule) {
  const p = {};
  for (const kv of String(rrule || "").split(";")) {
    const [k, v] = kv.split("=");
    if (k && v) p[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  return p;
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function addMonths(ms, n) {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}

/**
 * First occurrence at or after `from` (unix ms), or null when the series has ended.
 * Supports FREQ DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL and weekly BYDAY —
 * what calendar invitations use in practice. Exceptions (EXDATE) are ignored.
 */
export function nextOccurrence(start, rrule, from, end = FOREVER) {
  if (start === null || start === undefined) return null;
  if (!rrule) return start >= from ? start : null;
  const p = parseRule(rrule);
  const interval = Math.max(1, Number(p.INTERVAL) || 1);
  const count = p.COUNT ? Math.max(1, Number(p.COUNT)) : Infinity;
  const limit = Math.min(end, FOREVER);
  if (start >= from) return start <= limit ? start : null;
  const t0 = new Date(start);
  const tod = start - new Date(t0.getFullYear(), t0.getMonth(), t0.getDate()).getTime();
  if (p.FREQ === "DAILY" || (p.FREQ === "WEEKLY" && !p.BYDAY)) {
    const step = (p.FREQ === "DAILY" ? DAY : 7 * DAY) * interval;
    const k = Math.ceil((from - start) / step);
    if (k >= count) return null;
    const t = start + k * step;
    return t <= limit ? t : null;
  }
  if (p.FREQ === "WEEKLY") {
    const days = new Set(p.BYDAY.split(",").map((d) => WEEKDAYS[d.slice(-2)]).filter((d) => d !== undefined));
    if (!days.size) return null;
    // Weeks start on Monday; only every `interval`-th week (counted from the start's week) counts.
    const startMidnight = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate());
    const firstMonday = new Date(startMidnight);
    firstMonday.setDate(firstMonday.getDate() - ((startMidnight.getDay() + 6) % 7));
    const f = new Date(from);
    const day = new Date(f.getFullYear(), f.getMonth(), f.getDate());
    for (let i = 0; i < 7 * interval + 7; i++, day.setDate(day.getDate() + 1)) {
      if (!days.has(day.getDay())) continue;
      const weeks = Math.round((day.getTime() - firstMonday.getTime()) / (7 * DAY) - ((day.getDay() + 6) % 7) / 7);
      if (weeks % interval) continue;
      if (count !== Infinity && (weeks / interval) * days.size >= count) return null; // approximate
      const t = day.getTime() + tod;
      if (t < from || t < start) continue;
      return t <= limit ? t : null;
    }
    return null;
  }
  if (p.FREQ === "MONTHLY" || p.FREQ === "YEARLY") {
    const months = (p.FREQ === "YEARLY" ? 12 : 1) * interval;
    const d = new Date(from);
    let k = Math.max(0, (d.getFullYear() - t0.getFullYear()) * 12 + d.getMonth() - t0.getMonth());
    k = Math.floor(k / months);
    for (let guard = 0; guard < 3; guard++, k++) {
      if (k >= count) return null;
      const t = addMonths(start, k * months);
      if (t >= from) return t <= limit ? t : null;
    }
    return null;
  }
  return null;
}

/**
 * Recompute `active`, `last_start` and `next_start` for all events (call inside a transaction).
 * active = newest version of its event (UID + RECURRENCE-ID, by SEQUENCE then message date)
 *          and not cancelled.
 */
export function refreshEvents(db, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT e.rowid AS rid, e.uid, e.recurrence_id, e.sequence, e.method, e.status, e.start, e.rrule, e.parsed_last,
              e.active, e.last_start, e.next_start, m.date AS mdate, m.mid
       FROM events e JOIN messages m ON m.id = e.message_id`
    )
    .all();
  const groups = new Map();
  for (const r of rows) {
    const key = r.uid ? `${r.uid}\u0000${r.recurrence_id || ""}` : `\u0001${r.rid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const upd = db.prepare("UPDATE events SET active = ?, last_start = ?, next_start = ? WHERE rowid = ?");
  let changed = 0;
  for (const list of groups.values()) {
    // Replies of attendees (REPLY, COUNTER, …) are answers, not versions of the event.
    const versions = list.filter((r) => !NOT_VERSIONS.has(r.method));
    let best = null;
    for (const r of versions) {
      const k = [r.sequence ?? 0, r.mdate ?? 0];
      if (!best || k[0] > best[0] || (k[0] === best[0] && k[1] > best[1])) best = k;
    }
    const newest = best ? versions.filter((r) => (r.sequence ?? 0) === best[0] && (r.mdate ?? 0) === best[1]) : [];
    const cancelled = newest.some((r) => r.method === "CANCEL" || r.status === "CANCELLED");
    const newestMail = best ? best[1] : 0;
    for (const r of list) {
      const active = newest.includes(r) && !cancelled ? 1 : 0;
      let last = r.parsed_last ?? r.start;
      if (r.rrule && last !== null && last >= FOREVER) last = Math.max(r.start ?? 0, newestMail) + OPEN_END;
      const next = nextOccurrence(r.start, r.rrule, now, last ?? FOREVER);
      if (r.active !== active || r.last_start !== last || r.next_start !== next) {
        upd.run(active, last, next, r.rid);
        changed++;
      }
    }
  }
  return changed;
}
