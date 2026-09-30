// Incremental synchronisation: Thunderbird (via thunderbird-cli bridge) → SQLite index.
//
// 1. accounts + folders          (cheap)
// 2. list headers of changed folders and reconcile: flags, new, gone, moved (by Message-ID)
// 3. fetch content of new messages, newest first, in committed batches (Ctrl-C safe)
//
// Thunderbird's WebExtension message ids are only valid for one Thunderbird session.
// donner keeps its own stable ids and tracks the Thunderbird id together with an "epoch"
// that is bumped whenever a restart is detected.

import { getMeta, setMeta, tx, stmt } from "./db.js";
import { DonnerError } from "./errors.js";
import { matchesAny } from "./glob.js";
import { chooseBody } from "./mime.js";
import { kindOf } from "./attachments.js";
import { ParsePool } from "./parse-pool.js";
import { assignThread, rethreadAll, takeUnresolved } from "./threading.js";
import { refreshEvents } from "./calendar.js";
import { refreshIdentities, refreshContacts, authVerdict } from "./identity.js";
import { splitQuoted, makeSnippet, normalizeSubject, parseAddress, splitAddressList, sanitizeText, cleanMid, fold } from "./text.js";

const BATCH = 50;

// ─── Folder selection ───────────────────────────────────────────────

// Thunderbird reports special folders via `type` (deprecated in newer versions in favour of
// `specialUse`). If it is missing, fall back to well-known names so junk and trash are still
// excluded by default.
// Leading punctuation is ignored ("+spamverdacht", "[Gmail]/Spam", "_Junk").
const TYPE_BY_NAME = [
  [/^[^\p{L}\p{N}]*(junk|spam|bulk|bulk mail|junk-e-mail|junk e-mail|junk email|unerwünscht|spamverdacht|spam-verdacht|verdächtig|indésirables|pourriel|correo no deseado|posta indesiderata)$/iu, "junk", true],
  [/^[^\p{L}\p{N}]*(trash|deleted|deleted items|deleted messages|papierkorb|gelöschte elemente|gelöschte objekte|corbeille|papelera|cestino)$/iu, "trash", true],
  [/^[^\p{L}\p{N}]*(sent|sent[ _-]?mail|sent[ _-]?items|sent[ _-]?messages|gesendet|gesendete elemente|gesendete objekte|gesendete nachrichten|envoyés|enviados|posta inviata)(?:[ _-]?\d{1,3})?$/iu, "sent", true],
  [/^(drafts|entwürfe|brouillons|borradores)$/i, "drafts", false],
  [/^(inbox|posteingang)$/i, "inbox", false],
  [/^(archive|archives|archiv)$/i, "archives", false],
];

export function folderType(f) {
  if (f.type) return f.type;
  const special = Array.isArray(f.specialUse) ? f.specialUse[0] : null;
  if (special) return special;
  if (!f.path) return null;
  const segments = f.path.split("/").filter(Boolean);
  const name = f.name || segments[segments.length - 1] || "";
  // Junk, trash and sent folders are recognised at any depth (archived accounts in Local
  // Folders, server-side filters like "Uni/+spamverdacht"); the rest only at the top.
  for (const [re, t, anyDepth] of TYPE_BY_NAME) if ((anyDepth || segments.length === 1) && re.test(name)) return t;
  return null;
}

export function folderIndexed(cfg, account, folder) {
  const ix = cfg.index;
  if (ix.accounts?.length && !ix.accounts.some((a) => a === account.id || a.toLowerCase?.() === String(account.name).toLowerCase())) return false;
  const label = `${account.name}${folder.path}`;
  const candidates = [label, folder.id];
  if (ix.includeFolders?.length && !candidates.some((c) => matchesAny(c, ix.includeFolders))) return false;
  if (candidates.some((c) => matchesAny(c, ix.excludeFolders))) return false;
  const type = folderType(folder);
  if (type && ix.excludeFolderTypes?.includes(type)) return false;
  return true;
}

// ─── Header helpers ─────────────────────────────────────────────────

function addrList(list) {
  return splitAddressList(list || [])
    .map(parseAddress)
    .map((a) => ({ name: sanitizeText(a.name).text, addr: a.addr }))
    .filter((a) => a.addr || a.name);
}

function remoteEntry(m) {
  return {
    tbId: m.id,
    mid: cleanMid(m.headerMessageId) || `tb-${m.id}`,
    date: m.date ? Date.parse(m.date) : null,
    author: m.author || "",
    subject: sanitizeText(m.subject || "").text,
    to: addrList(m.recipients),
    cc: addrList(m.ccList),
    bcc: addrList(m.bccList),
    read: m.read ? 1 : 0,
    flagged: m.flagged ? 1 : 0,
    junk: m.junk ? 1 : 0,
    tags: JSON.stringify(m.tags || []),
    size: m.size || 0,
  };
}

function peopleText(from, lists) {
  const parts = [];
  for (const a of [from, ...lists.flat()]) {
    if (!a) continue;
    if (a.name) parts.push(a.name);
    if (a.addr) parts.push(a.addr);
  }
  return [...new Set(parts)].join(" ");
}

// ─── Sync ───────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {import('node:sqlite').DatabaseSync} p.db
 * @param {import('./bridge.js').BridgeClient} p.bridge
 * @param {object} p.cfg effective config
 * @param {boolean} [p.full] list every folder (flags, deletions) even if unchanged
 * @param {boolean} [p.bodies] fetch message content (default cfg.index.bodies)
 * @param {string[]} [p.folders] only these folder ids / globs
 * @param {(ev: object) => void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 */
export async function sync({ db, bridge, cfg, full = false, bodies = cfg.index.bodies, folders: onlyFolders = null, onProgress = () => {}, signal = null, now = Date.now }) {
  const started = now();
  const stats = { accounts: 0, folders: 0, foldersListed: 0, added: 0, moved: 0, removed: 0, updated: 0, contentFetched: 0, contentErrors: 0, pending: 0, epochChanged: false, aborted: false };
  const aborted = () => signal?.aborted;

  const status = await bridge.bridgeStatus();
  if (status?.extension && status.extension !== "connected") {
    throw new DonnerError("EXTENSION_DISCONNECTED", "The bridge is running, but Thunderbird is not connected.",
      "Open Thunderbird and make sure the \"Thunderbird AI Bridge\" add-on is enabled.");
  }
  const health = await bridge.health();
  setMeta(db, "tb_extension_version", health?.version ?? "");

  // ── Epoch (Thunderbird session) detection ─────────────────────────
  let epoch = Number(getMeta(db, "tb_epoch") || 1);
  if (await sessionChanged(db, bridge, epoch)) {
    epoch += 1;
    setMeta(db, "tb_epoch", epoch);
    stats.epochChanged = true;
  }

  // ── Accounts and folders ──────────────────────────────────────────
  onProgress({ phase: "accounts" });
  const accounts = await bridge.accounts();
  const seenAccounts = new Set();
  const folderPlan = [];
  const allRemoteFolders = new Set();
  const accountIdentities = [];
  for (const a of accounts) {
    seenAccounts.add(a.id);
    const email = a.identities?.[0]?.email || null;
    for (const i of a.identities || []) if (i?.email) accountIdentities.push({ addr: i.email, name: i.name, accountId: a.id, tbIdentity: i.id ?? null });
    db.prepare(
      `INSERT INTO accounts(id, name, type, email, updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, email=excluded.email, updated_at=excluded.updated_at`
    ).run(a.id, a.name, a.type, email, now());
    stats.accounts++;
    const flist = await bridge.folders(a.id);
    for (const f of flist) {
      if (!f.path || f.path === "/") continue;
      allRemoteFolders.add(f.id);
      const indexed = folderIndexed(cfg, a, f) ? 1 : 0;
      db.prepare(
        `INSERT INTO folders(id, account_id, path, name, type, total, unread, indexed) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, path=excluded.path, name=excluded.name, type=excluded.type,
           total=excluded.total, unread=excluded.unread, indexed=excluded.indexed`
      ).run(f.id, a.id, f.path, f.name, folderType(f), f.totalMessageCount ?? 0, f.unreadMessageCount ?? 0, indexed);
      stats.folders++;
      if (!indexed) continue;
      if (onlyFolders && !onlyFolders.some((o) => o === f.id || matchesAny(`${a.name}${f.path}`, [o]) || matchesAny(f.id, [o]))) continue;
      folderPlan.push({ id: f.id, accountId: a.id, total: f.totalMessageCount ?? 0, unread: f.unreadMessageCount ?? 0 });
    }
  }

  // Known own addresses before messages are threaded (threading ignores the user as a
  // shared participant); refreshed again at the end with senders from sent folders.
  tx(db, () => refreshIdentities(db, { accountIdentities, myAddresses: cfg.index.myAddresses, notMyAddresses: cfg.index.notMyAddresses }));

  // Accounts, folders or configuration changes that remove things from the index.
  const removedLater = [];
  tx(db, () => {
    for (const row of db.prepare("SELECT id FROM accounts").all()) {
      if (!seenAccounts.has(row.id)) {
        stats.removed += db.prepare("DELETE FROM messages WHERE account_id = ?").run(row.id).changes;
        db.prepare("DELETE FROM folders WHERE account_id = ?").run(row.id);
        db.prepare("DELETE FROM accounts WHERE id = ?").run(row.id);
      }
    }
    // Excluded folders: purge (privacy — "excluded" must mean "not in the index").
    stats.removed += db.prepare("DELETE FROM messages WHERE folder_id IN (SELECT id FROM folders WHERE indexed = 0)").run().changes;
  });
  // Vanished folders: their messages become "gone" candidates so a rename is detected as a move.
  const vanished = db.prepare("SELECT id FROM folders").all().filter((r) => !allRemoteFolders.has(r.id)).map((r) => r.id);
  for (const fid of vanished) removedLater.push(fid);

  // ── Decide which folders to list ──────────────────────────────────
  const fullEvery = (cfg.index.fullReconcileHours ?? 24) * 3600 * 1000;
  const toList = folderPlan.filter((f) => {
    const row = db.prepare("SELECT sync_total, sync_unread, reconciled_at FROM folders WHERE id = ?").get(f.id);
    if (full || !row || row.reconciled_at === null) return true;
    if (row.sync_total !== f.total || row.sync_unread !== f.unread) return true;
    if (now() - row.reconciled_at > fullEvery) return true;
    const pending = db.prepare("SELECT 1 FROM messages WHERE folder_id = ? AND content_state IN ('pending','error') LIMIT 1").get(f.id);
    return !!pending;
  });

  // ── List + reconcile ──────────────────────────────────────────────
  const listedFolders = [];
  const newCandidates = []; // {folderId, accountId, entry}
  const goneCandidates = []; // local rows {id, mid, folder_id}
  let listedIndex = 0;
  for (const f of toList) {
    if (aborted()) break;
    listedIndex++;
    onProgress({ phase: "list", folder: f.id, index: listedIndex, total: toList.length });
    let remote;
    try {
      remote = await listFolderHeaders(bridge, f, cfg);
    } catch (err) {
      if (err.code === "NOT_FOUND") {
        removedLater.push(f.id);
        continue;
      }
      db.prepare("UPDATE folders SET error = ? WHERE id = ?").run(err.message.slice(0, 500), f.id);
      onProgress({ phase: "warn", folder: f.id, message: err.message });
      continue;
    }
    const entries = remote.map(remoteEntry);
    tx(db, () => {
      const local = db.prepare("SELECT id, mid, read, flagged, junk, tags, tb_id, tb_epoch FROM messages WHERE folder_id = ?").all(f.id);
      const byMid = new Map();
      for (const row of local) {
        if (!byMid.has(row.mid)) byMid.set(row.mid, []);
        byMid.get(row.mid).push(row);
      }
      const upd = db.prepare("UPDATE messages SET read=?, flagged=?, junk=?, tags=?, tb_id=?, tb_epoch=?, updated_at=? WHERE id=?");
      for (const e of entries) {
        const rows = byMid.get(e.mid);
        const row = rows?.shift();
        if (row) {
          if (row.read !== e.read || row.flagged !== e.flagged || row.junk !== e.junk || row.tags !== e.tags || row.tb_id !== e.tbId || row.tb_epoch !== epoch) {
            upd.run(e.read, e.flagged, e.junk, e.tags, e.tbId, epoch, now(), row.id);
            if (row.read !== e.read || row.flagged !== e.flagged || row.junk !== e.junk || row.tags !== e.tags) stats.updated++;
          }
        } else {
          newCandidates.push({ folderId: f.id, accountId: f.accountId, entry: e });
        }
      }
      for (const rows of byMid.values()) for (const row of rows) goneCandidates.push({ id: row.id, mid: row.mid, folderId: f.id });
    });
    listedFolders.push(f);
    await new Promise((r) => setImmediate(r));
    stats.foldersListed++;
  }

  // Messages in folders that vanished entirely are gone candidates too.
  for (const fid of removedLater) {
    for (const row of db.prepare("SELECT id, mid FROM messages WHERE folder_id = ?").all(fid)) goneCandidates.push({ id: row.id, mid: row.mid, folderId: fid });
  }

  // ── Moves, deletions, insertions ──────────────────────────────────
  if (!aborted()) {
    const goneByMid = new Map();
    for (const g of goneCandidates) {
      if (!goneByMid.has(g.mid)) goneByMid.set(g.mid, []);
      goneByMid.get(g.mid).push(g);
    }
    const toInsert = [];
    tx(db, () => {
      const move = db.prepare("UPDATE messages SET folder_id=?, account_id=?, tb_id=?, tb_epoch=?, read=?, flagged=?, junk=?, tags=?, updated_at=? WHERE id=?");
      for (const c of newCandidates) {
        const e = c.entry;
        const g = goneByMid.get(e.mid)?.shift();
        if (g) {
          move.run(c.folderId, c.accountId, e.tbId, epoch, e.read, e.flagged, e.junk, e.tags, now(), g.id);
          stats.moved++;
        } else toInsert.push(c);
      }
      const del = db.prepare("DELETE FROM messages WHERE id = ?");
      for (const list of goneByMid.values()) for (const g of list) stats.removed += del.run(g.id).changes;
      for (const fid of removedLater) db.prepare("DELETE FROM folders WHERE id = ?").run(fid);
    });
    // Inserts in chunks, yielding to the event loop so a large first sync does not stall
    // other work in the same process (e.g. the MCP server answering requests).
    const insert = db.prepare(
      `INSERT INTO messages(mid, folder_id, account_id, tb_id, tb_epoch, date, from_name, from_addr, from_fold, to_json, cc_json, bcc_json,
         subject, subject_norm, size, read, flagged, junk, tags, people, snippet, content_state, indexed_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (let k = 0; k < toInsert.length && !aborted(); k += 1000) {
      tx(db, () => {
        for (const c of toInsert.slice(k, k + 1000)) {
          const e = c.entry;
          const from = parseAddress(e.author);
          from.name = sanitizeText(from.name).text;
          const r = insert.run(
            e.mid, c.folderId, c.accountId, e.tbId, epoch, e.date, from.name, from.addr, fold(`${from.name} ${from.addr}`),
            JSON.stringify(e.to), JSON.stringify(e.cc), JSON.stringify(e.bcc),
            e.subject, normalizeSubject(e.subject).toLowerCase(), e.size, e.read, e.flagged, e.junk, e.tags,
            peopleText(from, [e.to, e.cc, e.bcc]), "", bodies ? "pending" : "headers", now(), now()
          );
          const id = Number(r.lastInsertRowid);
          writeAddresses(db, id, from, e.to, e.cc, e.bcc, []);
          if (!bodies) assignThread(db, id, e.mid, [], e.subject, e.date);
          stats.added++;
        }
      });
      onProgress({ phase: "insert", done: Math.min(k + 1000, toInsert.length), total: toInsert.length });
      await new Promise((r) => setImmediate(r));
    }
    // Only now mark the listed folders as up to date: an interrupted run lists them again.
    if (!aborted()) {
      tx(db, () => {
        const upd = db.prepare("UPDATE folders SET synced_at=?, reconciled_at=?, sync_total=?, sync_unread=?, error=NULL WHERE id=?");
        for (const f of listedFolders) upd.run(now(), now(), f.total, f.unread, f.id);
      });
    }
  }

  // ── Content ───────────────────────────────────────────────────────
  if (bodies && !aborted()) {
    await fetchContent({ db, bridge, cfg, epoch, stats, onProgress, aborted, now });
  }
  stats.pending = db.prepare("SELECT count(*) AS n FROM messages WHERE content_state IN ('pending','error')").get().n;
  // The user's addresses (all account identities, configured ones, senders in sent folders)
  // and the people they write to; used by from:me, direction, people and triage.
  tx(db, () => {
    refreshIdentities(db, { accountIdentities, myAddresses: cfg.index.myAddresses, notMyAddresses: cfg.index.notMyAddresses });
    refreshContacts(db);
  });
  // Calendar state: newest version per event, cancellations, next occurrences.
  tx(db, () => refreshEvents(db));
  if ((takeUnresolved(db) || getMeta(db, "rethread") === "1") && !aborted()) {
    onProgress({ phase: "threads" });
    rethreadAll(db);
    setMeta(db, "rethread", null);
  }
  // Keep the query planner's statistics current (cheap; only analyses what changed a lot).
  try {
    db.exec("PRAGMA optimize");
  } catch {
    // best effort
  }
  stats.aborted = !!aborted();
  if (!stats.aborted) setMeta(db, "last_sync", now());
  if (!stats.aborted && (full || toList.length === folderPlan.length)) setMeta(db, "last_full_sync", now());
  stats.durationMs = now() - started;
  onProgress({ phase: "done", stats });
  return stats;
}

/** True when stored Thunderbird ids no longer point at the same messages. */
async function sessionChanged(db, bridge, epoch) {
  const sample = db.prepare("SELECT tb_id, mid FROM messages WHERE tb_id IS NOT NULL AND tb_epoch = ? ORDER BY updated_at DESC LIMIT 3").all(epoch);
  for (const row of sample) {
    try {
      const h = await bridge.headers(row.tb_id);
      if (cleanMid(h?.headerMessageId) !== row.mid) return true;
    } catch (err) {
      if (err.code === "NOT_FOUND" || err.code === "THUNDERBIRD_ERROR") return true;
      throw err;
    }
  }
  return false;
}

async function listFolderHeaders(bridge, f, cfg) {
  const chunk = cfg.index.listChunk || 20000;
  const timeoutMs = Math.max(cfg.bridge.timeoutMs || 120000, 600000);
  if (f.total <= chunk) {
    const r = await bridge.listFolder(f.id, f.total + 1000, { timeoutMs });
    if (!r.hasMore) return r.messages;
  }
  // Large folder: query date windows so each response stays bounded.
  const out = [];
  const seen = new Set();
  const windows = [[0, Date.UTC(1995, 0, 1)]];
  const thisYear = new Date().getUTCFullYear();
  for (let y = 1995; y <= thisYear + 1; y++) windows.push([Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)]);
  windows.push([Date.UTC(thisYear + 2, 0, 1), 8.64e15]);
  while (windows.length) {
    const [from, to] = windows.shift();
    const r = await bridge.search({ folderId: f.id, fromDate: new Date(from).toISOString(), toDate: new Date(to - 1).toISOString(), includeJunk: true, limit: chunk + 1 }, { timeoutMs });
    if (r.messages.length > chunk && to - from > 3600 * 1000) {
      const mid = Math.floor((from + to) / 2);
      windows.unshift([from, mid], [mid, to]);
      continue;
    }
    for (const m of r.messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

function writeAddresses(db, id, from, to, cc, bcc, replyTo) {
  stmt(db, "DELETE FROM addresses WHERE message_id = ?").run(id);
  const ins = stmt(db, "INSERT INTO addresses(message_id, role, name, addr, fold) VALUES(?,?,?,?,?)");
  const f = (a) => fold(`${a.name || ""} ${a.addr || ""}`);
  if (from && (from.addr || from.name)) ins.run(id, "from", from.name || null, from.addr || null, f(from));
  for (const [role, list] of [["to", to], ["cc", cc], ["bcc", bcc], ["reply-to", replyTo]]) {
    for (const a of list || []) ins.run(id, role, a.name || null, a.addr || null, f(a));
  }
}

// ─── Content ────────────────────────────────────────────────────────

async function fetchContent({ db, bridge, cfg, epoch, stats, onProgress, aborted, now }) {
  const pending = db
    .prepare("SELECT id, mid, folder_id, account_id, from_addr, tb_id, tb_epoch, size, subject, date FROM messages WHERE content_state IN ('pending','error') ORDER BY date DESC")
    .all();
  if (!pending.length) return;
  const n = Math.max(1, Math.min(16, cfg.index.concurrency || 4));
  const pool = new ParsePool({ size: n, timeoutMs: cfg.index.parseTimeoutMs || 60000 });
  const total = pending.length;
  let done = 0;
  let queue = 0;
  const results = [];
  const flush = () => {
    if (!results.length) return;
    const batch = results.splice(0, results.length);
    tx(db, () => {
      for (const r of batch) writeContent(db, r, now);
    });
  };

  let fatal = null;
  // tb-bridge keeps requests open until their timeout when Thunderbird goes away. A watchdog
  // checks the bridge whenever a download is slow and cancels everything if Thunderbird left.
  const cancel = new AbortController();
  const inflight = new Map(); // row id -> start time
  const fail = (err) => {
    fatal = fatal || err;
    cancel.abort(fatal);
  };
  const watchdog = setInterval(async () => {
    const slow = [...inflight.values()].some((t) => Date.now() - t > 4000);
    if (!slow || fatal) return;
    try {
      const st = await bridge.bridgeStatus();
      if (st?.extension && st.extension !== "connected") {
        fail(new DonnerError("EXTENSION_DISCONNECTED", "Thunderbird disconnected during sync.", "Progress so far is saved; run `donner sync` again when Thunderbird is back."));
      }
    } catch (err) {
      if (err.code === "BRIDGE_UNREACHABLE") fail(err);
    }
  }, 2000);
  watchdog.unref?.();
  const worker = async () => {
    while (queue < pending.length && !aborted() && !fatal) {
      const row = pending[queue++];
      let result;
      try {
        // A copy of the same message in another folder of the same account already has
        // content: reuse it. Message-IDs are sender-controlled, so size and sender must match too.
        const twin = db
          .prepare("SELECT id FROM messages INDEXED BY messages_mid WHERE mid = ? AND id != ? AND account_id IS ? AND size IS ? AND from_addr IS ? AND content_state IN ('full','parts') LIMIT 1")
          .get(row.mid, row.id, row.account_id, row.size, row.from_addr);
        if (twin) result = { row, copyFrom: twin.id };
        else {
          inflight.set(row.id, Date.now());
          try {
            const tbId = await currentTbId(db, bridge, row, epoch);
            result = { row, content: await loadContent(bridge, tbId, row.size, cfg, pool, cancel.signal) };
          } finally {
            inflight.delete(row.id);
          }
        }
        stats.contentFetched++;
      } catch (err) {
        if (["BRIDGE_UNREACHABLE", "EXTENSION_DISCONNECTED", "AUTH_REQUIRED", "ABORTED"].includes(err.code) || fatal) {
          // Stop all workers; what was fetched so far is committed below.
          if (err.code !== "ABORTED") fail(err);
          return;
        }
        result = { row, error: err.message || String(err) };
        stats.contentErrors++;
      }
      results.push(result);
      done++;
      if (results.length >= BATCH) flush();
      if (done % 10 === 0 || done === total) onProgress({ phase: "content", done, total });
    }
  };
  try {
    await Promise.all(Array.from({ length: n }, worker));
  } finally {
    clearInterval(watchdog);
    flush();
    await pool.close();
  }
  if (fatal) throw fatal;
}

async function currentTbId(db, bridge, row, epoch) {
  if (row.tb_id !== null && row.tb_epoch === epoch) return row.tb_id;
  const r = await bridge.search({ headerMessageId: row.mid, folderId: row.folder_id, includeJunk: true, limit: 5 });
  const m = r.messages?.[0];
  if (!m) throw new DonnerError("NOT_FOUND", "Message no longer in Thunderbird");
  stmt(db, "UPDATE messages SET tb_id = ?, tb_epoch = ? WHERE id = ?").run(m.id, epoch, row.id);
  return m.id;
}

async function loadContent(bridge, tbId, size, cfg, pool, signal) {
  const ix = cfg.index;
  if (!size || size <= ix.maxMessageBytes) {
    const raw = await bridge.raw(tbId, { signal });
    const parsed = await pool.parse(raw, {
      attachments: ix.attachments,
      maxAttachmentBytes: ix.maxAttachmentBytes,
      maxAttachmentTextChars: ix.maxAttachmentTextChars,
      pdftotext: ix.pdftotext !== false && ix.pdftotext !== "false",
      trustedAuthservIds: ix.trustedAuthservIds || [],
    });
    return { kind: "full", parsed };
  }
  // Too large to transfer raw: use Thunderbird's decoded text parts, and fetch the attachments
  // that are small enough one by one (a 25 KB contract next to a 30 MB video).
  const msg = await bridge.message(tbId, { signal });
  const { body, hiddenRemoved } = chooseBody(msg.parts?.text, msg.parts?.html);
  const pdftotext = ix.pdftotext !== false && ix.pdftotext !== "false";
  const attachments = [];
  // Only genuinely small attachments: every byte goes through Thunderbird as base64 JSON.
  const perAttachment = Math.min(ix.maxAttachmentBytes || Infinity, ix.largeMessageAttachmentBytes ?? 2 * 1024 * 1024);
  let budget = 5 * perAttachment;
  let fetched = 0;
  for (const [i, a] of (msg.parts?.attachments || []).entries()) {
    const att = {
      idx: i + 1,
      partName: a.partName,
      filename: sanitizeText(a.name || "").text,
      contentType: a.contentType,
      size: a.size ?? null,
      text: "",
      state: "too_large",
    };
    attachments.push(att);
    if (!ix.attachments || !a.partName || !kindOf(a.name, a.contentType)) {
      att.state = kindOf(a.name, a.contentType) ? "skipped" : "unsupported";
      continue;
    }
    if (a.size === null || a.size === undefined || a.size > perAttachment || a.size > budget || fetched >= 10) continue;
    try {
      const file = await bridge.attachment(tbId, a.partName, { signal });
      budget -= file.data.length;
      fetched++;
      const r = await pool.parse(file.data, {
        attachment: { filename: a.name, contentType: a.contentType },
        maxChars: ix.maxAttachmentTextChars,
        maxBytes: ix.maxAttachmentBytes,
        pdftotext,
      });
      att.text = r.text || "";
      att.state = r.state;
      att.events = r.events;
    } catch (err) {
      if (signal?.aborted || ["BRIDGE_UNREACHABLE", "EXTENSION_DISCONNECTED", "AUTH_REQUIRED", "ABORTED"].includes(err.code)) throw err;
      att.state = "error";
    }
  }
  return { kind: "parts", parsed: { body, hiddenRemoved, attachments, references: [], inReplyTo: [], auth: null, listId: null } };
}

function writeContent(db, r, now) {
  const { row } = r;
  if (!stmt(db, "SELECT 1 FROM messages WHERE id = ?").get(row.id)) return; // deleted meanwhile
  if (r.error) {
    stmt(db, "UPDATE messages SET content_state = 'error', content_error = ?, updated_at = ? WHERE id = ?").run(r.error.slice(0, 500), now(), row.id);
    return;
  }
  if (r.copyFrom) {
    stmt(db, 
      `UPDATE messages SET (body, quoted, snippet, att_text, attachment_count, auth_json, auth_verdict, hidden_removed, in_reply_to, list_id, reply_to, content_state, content_error, updated_at) =
       (SELECT body, quoted, snippet, att_text, attachment_count, auth_json, auth_verdict, hidden_removed, in_reply_to, list_id, reply_to, content_state, NULL, ? FROM messages WHERE id = ?)
       WHERE id = ?`
    ).run(now(), r.copyFrom, row.id);
    stmt(db, "DELETE FROM attachments WHERE message_id = ?").run(row.id);
    stmt(db, 
      "INSERT INTO attachments(message_id, idx, part_name, filename, content_type, size, text, text_state) SELECT ?, idx, part_name, filename, content_type, size, text, text_state FROM attachments WHERE message_id = ?"
    ).run(row.id, r.copyFrom);
    stmt(db, "DELETE FROM events WHERE message_id = ?").run(row.id);
stmt(db, `INSERT INTO events(message_id, start, end, summary, location, organizer, method, status, rrule, uid, last_start, sequence, recurrence_id, parsed_last)
      SELECT ?, start, end, summary, location, organizer, method, status, rrule, uid, last_start, sequence, recurrence_id, parsed_last FROM events WHERE message_id = ?`).run(row.id, r.copyFrom);
    stmt(db, "DELETE FROM refs WHERE message_id = ?").run(row.id);
    stmt(db, "INSERT INTO refs(message_id, ref_mid) SELECT ?, ref_mid FROM refs WHERE message_id = ?").run(row.id, r.copyFrom);
    assignThread(db, row.id, row.mid, stmt(db, "SELECT ref_mid FROM refs WHERE message_id = ?").all(row.id).map((x) => x.ref_mid), row.subject, row.date);
    return;
  }
  const p = r.content.parsed;
  const maxBody = 500000;
  const { own, quoted } = splitQuoted(p.body || "");
  const body = own.slice(0, maxBody);
  const atts = p.attachments || [];
  const attText = atts
    .map((a) => [a.filename, a.text].filter(Boolean).join("\n"))
    .join("\n\n")
    .slice(0, maxBody);
  const refs = [...new Set([...(p.references || []), ...(p.inReplyTo || [])])].filter((m) => m && m !== row.mid);

  const sets = {
    body,
    quoted: quoted.slice(0, maxBody),
    snippet: makeSnippet(own || quoted),
    att_text: attText,
    attachment_count: atts.length,
    auth_json: p.auth ? JSON.stringify(p.auth) : null,
    auth_verdict: authVerdict(p.auth),
    hidden_removed: p.hiddenRemoved ? 1 : 0,
    in_reply_to: p.inReplyTo?.[0] || null,
    list_id: p.listId || null,
    reply_to: p.replyTo?.length ? JSON.stringify(p.replyTo) : null,
    content_state: r.content.kind,
    content_error: null,
    updated_at: now(),
  };
  if (r.content.kind === "full") {
    // The raw source has properly decoded headers (names with encoded words, Bcc on sent mail).
    if (p.from?.addr) {
      sets.from_name = p.from.name;
      sets.from_addr = p.from.addr;
    }
    if (p.to?.length) sets.to_json = JSON.stringify(p.to);
    if (p.cc?.length) sets.cc_json = JSON.stringify(p.cc);
    if (p.bcc?.length) sets.bcc_json = JSON.stringify(p.bcc);
    if (p.subject) {
      sets.subject = p.subject;
      sets.subject_norm = normalizeSubject(p.subject).toLowerCase();
    }
  }
  const cur = stmt(db, "SELECT from_name, from_addr, to_json, cc_json, bcc_json FROM messages WHERE id = ?").get(row.id);
  const from = { name: sets.from_name ?? cur.from_name, addr: sets.from_addr ?? cur.from_addr };
  const to = JSON.parse(sets.to_json ?? cur.to_json ?? "[]");
  const cc = JSON.parse(sets.cc_json ?? cur.cc_json ?? "[]");
  const bcc = JSON.parse(sets.bcc_json ?? cur.bcc_json ?? "[]");
  sets.people = peopleText(from, [to, cc, bcc]);
  sets.from_fold = fold(`${from.name || ""} ${from.addr || ""}`);

  const cols = Object.keys(sets);
  stmt(db, `UPDATE messages SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => sets[c]), row.id);
  writeAddresses(db, row.id, from, to, cc, bcc, p.replyTo || []);

  stmt(db, "DELETE FROM attachments WHERE message_id = ?").run(row.id);
  const insA = stmt(db, "INSERT INTO attachments(message_id, idx, part_name, filename, content_type, size, text, text_state) VALUES(?,?,?,?,?,?,?,?)");
  for (const a of atts) insA.run(row.id, a.idx, a.partName ?? null, a.filename ?? null, a.contentType ?? null, a.size ?? null, a.text || null, a.state);

  stmt(db, "DELETE FROM events WHERE message_id = ?").run(row.id);
  const insE = stmt(db, "INSERT INTO events(message_id, start, end, summary, location, organizer, method, status, rrule, uid, last_start, sequence, recurrence_id, parsed_last) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const a of atts) {
    for (const ev of a.events || []) {
      const last = ev.lastStart ?? ev.start ?? null;
      insE.run(row.id, ev.start ?? null, ev.end ?? null, ev.summary ?? null, ev.location ?? null, ev.organizer ?? null, ev.method ?? null, ev.status ?? null, ev.rrule ?? null, ev.uid ?? null, last, ev.sequence ?? null, ev.recurrenceId ?? null, last);
    }
  }

  stmt(db, "DELETE FROM refs WHERE message_id = ?").run(row.id);
  const insR = stmt(db, "INSERT INTO refs(message_id, ref_mid) VALUES(?, ?)");
  for (const m of refs) insR.run(row.id, m);
  assignThread(db, row.id, row.mid, refs, sets.subject ?? row.subject, row.date);
}
