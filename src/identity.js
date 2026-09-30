// The user's own addresses, known contacts and the sender-authentication verdict.
//
// "Me" is more than one address: every identity of every Thunderbird account, addresses the
// user configured (`index.myAddresses`), and senders found in sent folders (old accounts,
// aliases, archives in Local Folders). Queries use the `identities` table for from:me,
// direction (sent/received) and people statistics.

/**
 * Verdict from parsed Authentication-Results: "pass" | "fail" | null (no usable result).
 * DMARC decides when present: dkim=fail with dmarc=pass is normal for forwarded or
 * re-signed mail. Without DMARC, a message fails when nothing passes and SPF hard-fails or a
 * DKIM signature is broken (softfail alone does not count).
 */
export function authVerdict(auth) {
  if (!auth) return null;
  if (auth.dmarc === "pass") return "pass";
  if (auth.dmarc === "fail") return "fail";
  // SPF softfail alone is common for forwarded mail and old domains without DMARC; it is
  // not a failure. A hard SPF fail or a broken DKIM signature with nothing passing is.
  const spfFail = auth.spf === "fail";
  const dkimFail = auth.dkim === "fail";
  const anyPass = auth.spf === "pass" || auth.dkim === "pass";
  if ((spfFail || dkimFail) && !anyPass) return "fail";
  return null;
}

/** SQL for "the sender is one of my addresses". */
export const ME_SQL = "(SELECT addr FROM identities)";

const normAddr = (a) => String(a || "").trim().toLowerCase();

/**
 * Rebuild the identities table.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{accountIdentities?: {addr: string, name?: string, accountId?: string, tbIdentity?: string}[] | null,
 *          myAddresses?: string[], notMyAddresses?: string[]}} opts
 *   accountIdentities: null keeps the stored account identities (e.g. during a migration).
 */
export function refreshIdentities(db, { accountIdentities = null, myAddresses = [], notMyAddresses = [] } = {}) {
  const ignore = new Set((notMyAddresses || []).map(normAddr));
  const rows = new Map(); // addr -> {name, source, accountId, tbIdentity}
  const add = (addr, name, source, accountId = null, tbIdentity = null) => {
    addr = normAddr(addr);
    if (!addr || !addr.includes("@") || ignore.has(addr) || rows.has(addr)) return;
    rows.set(addr, { name: name || null, source, accountId, tbIdentity });
  };
  if (accountIdentities) for (const i of accountIdentities) add(i.addr, i.name, "account", i.accountId, i.tbIdentity);
  else {
    for (const r of db.prepare("SELECT addr, name, account_id, tb_identity FROM identities WHERE source = 'account'").all()) add(r.addr, r.name, "account", r.account_id, r.tb_identity);
    for (const r of db.prepare("SELECT id, email FROM accounts WHERE email IS NOT NULL").all()) add(r.email, null, "account", r.id);
  }
  for (const a of myAddresses || []) add(a, null, "config");

  // Senders in sent folders. A small threshold keeps a stray message (a draft someone else
  // wrote, a copy of a forwarded mail) from turning an address into "me".
  const sentTotal = db.prepare("SELECT count(*) AS n FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.type = 'sent'").get().n;
  const min = Math.max(2, Math.min(5, Math.ceil(sentTotal / 200)));
  const sent = db
    .prepare(
      `SELECT m.from_addr AS addr, count(DISTINCT m.mid) AS n FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE f.type = 'sent' AND m.from_addr LIKE '%@%' GROUP BY m.from_addr HAVING n >= ? ORDER BY n DESC LIMIT 200`
    )
    .all(min);
  for (const r of sent) add(r.addr, null, "sent");

  db.exec("DELETE FROM identities");
  const ins = db.prepare("INSERT INTO identities(addr, name, source, account_id, tb_identity) VALUES(?,?,?,?,?)");
  for (const [addr, r] of rows) ins.run(addr, r.name, r.source, r.accountId, r.tbIdentity ?? null);
  return [...rows.keys()];
}

/** Addresses the user has written to (for "known contact" and triage). */
export function refreshContacts(db) {
  db.exec("DELETE FROM contacts");
  db.exec(
    `INSERT INTO contacts(addr, sent, last_sent)
     SELECT ad.addr, count(DISTINCT m.mid), max(m.date) FROM addresses ad JOIN messages m ON m.id = ad.message_id
     WHERE ad.role IN ('to','cc','bcc') AND ad.addr LIKE '%@%' AND m.from_addr IN ${ME_SQL}
       AND ad.addr NOT IN ${ME_SQL}
     GROUP BY ad.addr`
  );
}

const nameKey = (n) =>
  String(n || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/["'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Addresses that are probably the user's but not known yet (old accounts, aliases whose mail
 * lies in archives): they send under the same full name as one of the user's identities,
 * regularly and without failing authentication. Suggestions only — shown by `doctor` and
 * `status`; confirmed addresses belong in index.myAddresses.
 */
export function suggestAddresses(db, { limit = 10, min = 3 } = {}) {
  const names = new Set();
  for (const r of db.prepare("SELECT name FROM identities WHERE name IS NOT NULL").all()) names.add(nameKey(r.name));
  // The names the user's known addresses actually send with.
  for (const r of db
    .prepare(
      `SELECT from_name AS name, count(*) AS n FROM messages WHERE from_addr IN ${ME_SQL} AND from_name IS NOT NULL AND from_name != ''
       GROUP BY from_name ORDER BY n DESC LIMIT 5`
    )
    .all())
    names.add(nameKey(r.name));
  const full = [...names].filter((n) => n.split(" ").length >= 2);
  if (!full.length) return [];
  const rows = db
    .prepare(
      `SELECT from_addr AS addr, from_name AS name, count(DISTINCT mid) AS n, sum(auth_verdict = 'fail') AS failed,
              min(date) AS first, max(date) AS last
       FROM messages
       WHERE from_addr LIKE '%@%' AND from_addr NOT IN ${ME_SQL} AND from_name IS NOT NULL
       GROUP BY from_addr, from_name`
    )
    .all();
  const byAddr = new Map();
  for (const r of rows) {
    const e = byAddr.get(r.addr) || { addr: r.addr, total: 0, matching: 0, failed: 0, first: r.first, last: r.last };
    e.total += r.n;
    e.failed += r.failed || 0;
    if (full.includes(nameKey(r.name))) {
      e.matching += r.n;
      e.name = r.name;
    }
    e.first = Math.min(e.first ?? r.first, r.first ?? e.first);
    e.last = Math.max(e.last ?? r.last, r.last ?? e.last);
    byAddr.set(r.addr, e);
  }
  return [...byAddr.values()]
    .filter((e) => e.matching >= min && e.matching * 2 >= e.total && e.failed * 10 < e.total)
    .sort((a, b) => b.matching - a.matching)
    .slice(0, limit)
    .map((e) => ({ addr: e.addr, name: e.name, messages: e.matching, first: e.first, last: e.last }));
}
