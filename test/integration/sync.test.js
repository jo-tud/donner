// Sync against the real thunderbird-cli bridge + extension on a simulated Thunderbird.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setupIndexed, idByMid, tempDir, testConfig } from "../helpers.js";
import { search, show, thread, threads, count, people, resolve, status } from "../../src/ops.js";
import { openDb } from "../../src/db.js";
import { BridgeClient } from "../../src/bridge.js";
import { sync } from "../../src/sync.js";
import { buildMessage } from "../fixtures/mime-builder.js";

let env;
before(async () => {
  env = await setupIndexed({ count: 400 });
});
after(async () => {
  await env?.cleanup();
});

test("initial sync indexes everything except junk and trash", () => {
  const { corpus, db, stats } = env;
  const expected = corpus.messages.filter((m) => !/\/(Junk|Trash|\+spamverdacht)$/.test(m.folderPath)).length;
  assert.equal(stats.added, expected);
  assert.equal(stats.contentErrors, 0);
  assert.equal(stats.pending, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM messages").get().n, expected);
  for (const j of corpus.facts.junk) assert.equal(idByMid(db, j.mid), undefined, "junk must not be indexed");
  for (const t of corpus.facts.trash) assert.equal(idByMid(db, t.mid), undefined, "trash must not be indexed");
  const excluded = db.prepare("SELECT count(*) n FROM folders WHERE indexed = 0").get().n;
  assert.ok(excluded >= 4);
  const unextracted = db.prepare("SELECT filename, text_state FROM attachments WHERE filename LIKE '%.pdf' AND text_state != 'extracted'").all();
  assert.deepEqual(unextracted, [], "every generated PDF yields text");
});

test("invoice amounts inside PDF attachments are searchable", () => {
  const { corpus, db } = env;
  for (const inv of corpus.facts.invoices.slice(0, 5)) {
    const r = search(db, { query: `"${inv.amountDe} EUR"`, fields: ["id", "subject"] });
    assert.ok(r.results.some((x) => x.subject.includes(inv.number)), `amount ${inv.amountDe} of ${inv.number}`);
  }
  const inv = corpus.facts.invoices[0];
  const r = search(db, { query: `${inv.number} has:pdf` });
  assert.ok(r.total >= 1);
});

test("query operators: from, account, folder, dates, flags, attachments", () => {
  const { db, corpus } = env;
  const r1 = search(db, { query: "from:stadtwerke", limit: 100, fields: ["id", "from"] });
  assert.ok(r1.total > 0);
  assert.ok(r1.results.every((x) => x.from.includes("stadtwerke")));
  const privat = search(db, { query: "account:Privat", limit: 1 });
  const firma = search(db, { query: "account:Firma", limit: 1 });
  const all = search(db, { query: "", limit: 1 });
  assert.ok(privat.total > 0 && firma.total > 0);
  assert.ok(privat.total + firma.total <= all.total);
  const sent = search(db, { query: "in:sent", limit: 200, fields: ["id", "from"] });
  const mine = new Set(corpus.me.map((a) => a.email).concat([corpus.facts.identity.alias, corpus.facts.identity.old]));
  assert.ok(sent.results.every((x) => mine.has(x.from.match(/<([^>]+)>/)?.[1] || x.from)));
  const y2025 = count(db, { query: "after:2025-01-01 before:2026-01-01" }).total;
  const byYear = count(db, { query: "", by: "year" });
  assert.equal(byYear.groups.find((g) => g.key === "2025").count, y2025);
  const withAtt = count(db, { query: "has:attachment" }).total;
  assert.ok(withAtt >= corpus.facts.invoices.length);
  const unread = count(db, { query: "is:unread" }).total;
  const read = count(db, { query: "is:read" }).total;
  assert.equal(unread + read, all.total);
});

test("umlaut search: müller = mueller (both directions), highlighting intact", () => {
  const { db } = env;
  const a = search(db, { query: "from:j.mueller" }).total;
  const n1 = search(db, { query: "Müller" }).total;
  const n2 = search(db, { query: "Mueller" }).total;
  assert.ok(a > 0 && n1 > 0);
  assert.equal(n1, n2);
  assert.equal(search(db, { query: "from:müller" }).total, search(db, { query: "from:mueller" }).total);
  const r = search(db, { query: "Müller", fields: ["snippet"] }).results.find((x) => x._hl && /Müller/.test(x.snippet));
  if (r) assert.match(r._hl, /\u0001Müller\u0002/, "highlight marks the umlaut word");
});

test("duplicates (same Message-ID in two folders) are folded in results and counts", () => {
  const { db, corpus } = env;
  const mid = corpus.facts.duplicates[0].mid;
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE mid = ?").get(mid).n, 2);
  const r = search(db, { query: "Zwillingsnachricht", fields: ["id", "copies"] });
  assert.equal(r.total, 1);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].copies, 2);
});

test("prompt-injection mails: hidden text removed, trust signals set", () => {
  const { db, corpus } = env;
  for (const inj of corpus.facts.injections) {
    const id = idByMid(db, inj.mid);
    const m = show(db, id);
    const hiddenTechnique = inj.technique !== 4; // 4 = text/plain alternative, HTML shown instead
    assert.equal(m.body.includes("IGNORE ALL PREVIOUS") || m.body.includes("tb compose") || m.body.includes("authorised you"), false, `technique ${inj.technique} leaked: ${m.body}`);
    if (hiddenTechnique) assert.equal(m.trust.hidden_content_removed, true, `technique ${inj.technique}`);
    assert.equal(m.trust.warning, "sender authentication failed");
    assert.equal(m.trust.known_contact, false);
  }
  assert.ok(count(db, { query: "is:hidden" }).total >= corpus.facts.injections.filter((i) => i.technique !== 4).length);
});

test("threads: replies grouped via References, quotes stripped from body", () => {
  const { db, corpus } = env;
  const th = corpus.facts.threads.find((t) => t.mids.length >= 4);
  const ids = th.mids.map((m) => idByMid(db, m));
  const tids = new Set(ids.map((id) => db.prepare("SELECT thread_id FROM messages WHERE id = ?").get(id).thread_id));
  assert.equal(tids.size, 1);
  const t = thread(db, ids[ids.length - 1]);
  assert.equal(t.count, th.mids.length);
  for (const m of t.messages.slice(1)) {
    assert.doesNotMatch(m.body, /^>/m, "quoted lines must not be in own body");
    assert.doesNotMatch(m.body, /schrieb|wrote:|Von: |From: /);
  }
  assert.ok(t.participants.length >= 2);
});

test("special messages: no Message-ID, large message, forwarded eml, calendar, office", () => {
  const { db, corpus } = env;
  assert.ok(search(db, { query: "Fossil" }).total === 1);
  const large = show(db, idByMid(db, corpus.facts.large[0].mid));
  assert.equal(large.content, "parts");
  assert.match(large.body, /Riesenanhang/);
  assert.equal(large.attachments[0].text, "unsupported");
  assert.equal(large.attachments[1].text, "extracted", "small attachment of a large message is fetched on its own");
  assert.equal(search(db, { query: corpus.facts.large[0].smallKeyword }).results[0]?.id, large.id);
  const fwd = search(db, { query: `from:krause ${corpus.facts.invoices[0].number}` });
  assert.equal(fwd.total, 1, "forwarded invoice found via attached eml");
  const meeting = corpus.facts.meetings[0];
  assert.ok(search(db, { query: `"${meeting.room}" has:ics` }).total >= 1);
  const doc = corpus.facts.docs[0];
  assert.ok(search(db, { query: String(doc.sum) }).total >= 1);
});

test("negated filters keep mail from folders without a type (NULL-safe)", () => {
  const { db } = env;
  const all = count(db, { query: "" }).total;
  const sent = count(db, { query: "in:sent" }).total;
  assert.equal(count(db, { query: "-in:sent" }).total, all - sent);
  const heise = count(db, { query: "list:heise" }).total;
  assert.equal(count(db, { query: "-list:heise" }).total, all - heise);
});

test("OR between filters, groups, with:, from:me, umlaut-folded participants", () => {
  const { db } = env;
  const a = count(db, { query: "from:bjorn" }).total;
  const b = count(db, { query: "to:bjorn" }).total;
  const either = count(db, { query: "from:bjorn OR to:bjorn" }).total;
  const withX = count(db, { query: "with:bjorn" }).total;
  assert.ok(a > 0 && b > 0);
  assert.equal(either, withX);
  assert.ok(either >= Math.max(a, b));
  assert.equal(count(db, { query: "from:bjoern" }).total, a, "oe = ö");
  assert.equal(count(db, { query: "from:BJÖRN" }).total, a, "case + umlaut");
  assert.equal(count(db, { query: "(from:bjorn OR to:bjorn) -in:sent" }).total, count(db, { query: "with:bjorn -in:sent" }).total);
  const mine = count(db, { query: "from:me" }).total;
  assert.equal(mine, count(db, { query: "in:sent" }).total, "sent mail of all identities; spam forging my address (auth fail) is not from me");
  for (const s of env.corpus.facts.spoofed) assert.equal(count(db, { query: `from:me mid:${s.mid}` }).total, 0);
  assert.ok(count(db, { query: "to:me" }).total > 0);
});

test("is:suspicious finds auth failures and hidden text outside mailing lists", () => {
  const { db, corpus } = env;
  const r = search(db, { query: "is:suspicious", limit: 500, fields: ["id", "from"] });
  const injIds = new Set(corpus.facts.injections.map((i) => idByMid(db, i.mid)));
  for (const id of injIds) assert.ok(r.results.some((x) => x.id === id), `injection ${id} flagged`);
  assert.ok(r.results.every((x) => !/heise|bahn|thunderbird/.test(x.from)), "newsletters with preheaders are not suspicious");
  const w = search(db, { query: "Kurze Frage" });
  assert.ok(w.results.every((x) => x.warning), "search results carry a warning");
});

test("calendar: invitations, versions, cancellations, series, next occurrence", async () => {
  const { db, corpus } = env;
  const cal = corpus.facts.calendar;
  const m = corpus.facts.meetings[0];
  const shown = show(db, idByMid(db, m.mid));
  assert.equal(shown.events.length, 1);
  assert.equal(shown.events[0].location, m.room);
  assert.equal(new Date(shown.events[0].start).getTime(), Math.floor(m.start / 1000) * 1000);
  // Fixed "now" so the test does not depend on the calendar date it runs on.
  const { refreshEvents } = await import("../../src/calendar.js");
  const { tx } = await import("../../src/db.js");
  tx(db, () => refreshEvents(db, Date.UTC(2026, 8, 20)));

  // has:invite = current, not cancelled REQUESTs: meetings, the stale 2024 series, the updated
  // review (not its first version), the Jour fixe; not the ticket, not the cancelled invitation.
  assert.equal(count(db, { query: "has:invite" }).total, corpus.facts.meetings.length + 3);
  assert.equal(count(db, { query: "has:event" }).total, corpus.facts.meetings.length + 7);
  assert.equal(search(db, { query: "has:cancelled", fields: ["mid"] }).results[0].mid, cal.cancel.mid);

  const upcoming = search(db, { query: "has:event event_after:2026-09-20", sort: "event", fields: ["mid", "event"], limit: 100 }).results;
  const mids = upcoming.map((r) => r.mid);
  assert.ok(mids.includes(cal.review.current), "updated invitation is upcoming");
  assert.ok(!mids.includes(cal.review.old), "its first version is not");
  assert.ok(!mids.includes(cal.cancelledInvite.mid) && !mids.includes(cal.cancel.mid), "cancelled event is not upcoming");
  assert.ok(!mids.includes(cal.series.mid), "open-ended series from 2024 has gone stale (newest mail + 1 year)");
  assert.ok(mids.includes(cal.jourFixe.mid) && mids.includes(cal.ticket.mid));
  // Sorted by the next occurrence: the Jour fixe (next Wednesday) comes before the train on 20 Oct.
  assert.ok(mids.indexOf(cal.jourFixe.mid) < mids.indexOf(cal.ticket.mid));
  const jf = upcoming.find((r) => r.mid === cal.jourFixe.mid).event;
  assert.equal(jf.repeats, "weekly on WE");
  assert.equal(new Date(jf.next).getTime(), Date.UTC(2026, 8, 23, 8));
  const nexts = upcoming.map((r) => r.event.next || r.event.start);
  assert.deepEqual(nexts, [...nexts].sort());
  assert.equal(show(db, idByMid(db, cal.review.old)).events[0].outdated, true);
  const ticket = show(db, idByMid(db, cal.ticket.mid), { attachments: true });
  assert.equal(ticket.events[0].invitation, undefined);
  assert.doesNotMatch(ticket.attachments.map((a) => a.content || "").join(""), /1893/);
});

test("folder filter accepts the displayed Account/Path form", () => {
  const { db } = env;
  const r = search(db, { query: "folder:Privat/Rechnungen", limit: 5, fields: ["folder"] });
  assert.ok(r.total > 0);
  assert.ok(r.results.every((x) => x.folder === "Privat/Rechnungen"));
});

test("people: correspondents with received and sent counts", () => {
  const { db } = env;
  const p = people(db, { limit: 5 });
  assert.equal(p.people.length, 5);
  assert.ok(p.people.every((x) => x.addr && x.received + x.sent > 0));
  assert.ok(!p.people.some((x) => x.addr === "anna.schmidt@firma.example"), "own address excluded");
  const one = people(db, { query: "Söderström" });
  assert.equal(one.people[0].addr, "bjorn@nordic.example");
  assert.equal(people(db, { query: "bjoern" }).people[0].addr, "bjorn@nordic.example");
  const last = db.prepare("SELECT max(date) d FROM messages WHERE from_addr = 'bjorn@nordic.example'").get().d;
  assert.equal(new Date(one.people[0].last_received).getTime(), Math.floor(last / 1000) * 1000);
});

test("incremental sync: new, moved, deleted, flags (full), unchanged is cheap", async () => {
  const { db, h, corpus, resync } = env;
  // unchanged
  const calls = h.tb.calls.list;
  const s0 = await resync();
  assert.equal(s0.foldersListed, 0);
  assert.equal(h.tb.calls.list, calls);

  // new message
  const raw = buildMessage({ from: { name: "Neu", email: "neu@example.com" }, to: [{ name: "Anna", email: "anna.schmidt@firma.example" }], subject: "Brandneu Quokka", date: Date.now(), messageId: "new-1@example.com", text: "Das Quokka ist da." });
  h.tb.addMessage({ accountId: "account1", folderPath: "/INBOX", raw, text: "Brandneu Quokka", bodyParts: [{ contentType: "text/plain", body: "Das Quokka ist da." }], attachments: [], meta: { date: Date.now(), author: "Neu <neu@example.com>", subject: "Brandneu Quokka", recipients: ["anna.schmidt@firma.example"], ccList: [], bccList: [], headerMessageId: "new-1@example.com", read: false, flagged: false, junk: false, tags: [], size: raw.length } });
  // move
  const inv = corpus.facts.invoices.find((i) => i.account === "account2" && i.folder === "/INBOX") || corpus.facts.invoices[0];
  const invRec = h.tb.findByMid(inv.mid)[0];
  const rawBefore = h.tb.calls.getRaw;
  h.tb.move(invRec.key, "account3", "/Archiv-Alt");
  // delete
  const victim = corpus.facts.shipping[0];
  h.tb.remove(h.tb.findByMid(victim.mid)[0].key);

  const s1 = await resync();
  assert.equal(s1.added, 1);
  assert.equal(s1.moved, 1);
  assert.equal(s1.removed, 1);
  assert.equal(h.tb.calls.getRaw - rawBefore, 1, "only the new message is downloaded");
  assert.equal(search(db, { query: "Quokka" }).total, 1);
  assert.equal(db.prepare("SELECT folder_id FROM messages WHERE mid = ?").get(inv.mid).folder_id, "account3://Archiv-Alt");
  assert.equal(idByMid(db, victim.mid), undefined);

  // flag change without count change is found by a full sync
  const th = corpus.facts.threads[1];
  const rec = h.tb.findByMid(th.mids[0])[0];
  h.tb.update(rec.key, { flagged: !rec.meta.flagged, tags: ["$label1"] });
  const quick = await resync();
  assert.equal(quick.updated, 0);
  const full = await resync({ full: true });
  assert.equal(full.updated, 1);
  assert.equal(count(db, { query: "tag:$label1" }).total, 1);
});

test("Thunderbird restart: ids re-validated, resolve returns the right message", async () => {
  const { db, h, bridge, resync, corpus } = env;
  const inv = corpus.facts.invoices[2];
  const id = idByMid(db, inv.mid);
  await h.restartThunderbird();
  const s = await resync();
  assert.equal(s.epochChanged, true);
  const r = await resolve(db, bridge, [id]);
  const tbId = r.resolved[0].tb_id;
  const hdr = await bridge.headers(tbId);
  assert.equal(hdr.headerMessageId, inv.mid);
});

test("resolve without a sync after restart still finds the right message", async () => {
  const { db, h, bridge, corpus } = env;
  const inv = corpus.facts.invoices[3];
  const id = idByMid(db, inv.mid);
  await h.restartThunderbird();
  // Access some other messages first so stale ids point elsewhere.
  await bridge.listFolder("account1://INBOX", 50);
  const r = await resolve(db, bridge, [id]);
  const hdr = await bridge.headers(r.resolved[0].tb_id);
  assert.equal(hdr.headerMessageId, inv.mid);
  await env.resync();
});

test("my addresses: all account identities, senders in sent folders at any depth", () => {
  const { db, corpus } = env;
  const ids = Object.fromEntries(db.prepare("SELECT addr, source FROM identities").all().map((r) => [r.addr, r.source]));
  for (const a of corpus.me) assert.equal(ids[a.email], "account");
  assert.equal(ids[corpus.facts.identity.alias], "account", "second identity of an account");
  assert.equal(ids[corpus.facts.identity.old], "sent", "old address found in Local Folders/Archiv-Alt/Gesendet");
  // Thunderbird identity ids for thunderbird-cli's compose "from" (thunderbird-cli issue #30).
  const mine = status(db, env.dbPath).my_addresses;
  assert.equal(mine.find((a) => a.addr === corpus.facts.identity.alias).tb_identity, "id1b");
  assert.equal(mine.find((a) => a.addr === corpus.facts.identity.old).tb_identity, undefined);
  assert.equal(db.prepare("SELECT type FROM folders WHERE path = '/Archiv-Alt/Gesendet'").get().type, "sent");
  assert.ok(count(db, { query: `from:me from:${corpus.facts.identity.old}` }).total >= corpus.facts.identity.oldSent);
  // People: my own addresses are not correspondents; names are the most frequent sender name.
  const p = people(db, { limit: 1000 }).people;
  for (const a of [...corpus.me, { email: corpus.facts.identity.alias }, { email: corpus.facts.identity.old }]) {
    assert.ok(!p.some((x) => x.addr === a.email), `${a.email} is not listed as a correspondent`);
  }
  const mueller = p.find((x) => x.addr === "j.mueller@firma.example");
  assert.equal(mueller.name, "Jürgen Müller");
});

test("addresses sent under the user's name but not configured are suggested, not assumed", async () => {
  const { db, corpus } = env;
  const st = status(db, env.dbPath);
  assert.deepEqual(st.possibly_mine.map((a) => a.addr), [corpus.facts.identity.archived]);
  assert.equal(st.possibly_mine[0].messages, 4);
  assert.ok(!st.my_addresses.some((a) => a.addr === corpus.facts.identity.archived));
  // Same surname, different first name (family) is not suggested.
  assert.ok(!st.possibly_mine.some((a) => /mueller|weiss/.test(a.addr)));
  // Once configured, it is the user's.
  const { refreshIdentities, refreshContacts } = await import("../../src/identity.js");
  const { tx } = await import("../../src/db.js");
  tx(db, () => {
    refreshIdentities(db, { myAddresses: [corpus.facts.identity.archived] });
    refreshContacts(db);
  });
  assert.equal(status(db, env.dbPath).possibly_mine.length, 0);
  assert.equal(count(db, { query: `from:me from:${corpus.facts.identity.archived}` }).total, 4);
  tx(db, () => {
    refreshIdentities(db);
    refreshContacts(db);
  });
});

test("trust: DMARC decides, split Authentication-Results headers are merged, preheaders are not suspicious", () => {
  const { db, corpus } = env;
  const split = show(db, idByMid(db, corpus.facts.authSplit[0].mid));
  assert.deepEqual(split.trust.auth, { dmarc: "pass", spf: "pass", dkim: "pass" });
  assert.equal(split.trust.authenticated, true);
  assert.equal(split.trust.hidden_content_removed, true);
  const suspicious = new Set(search(db, { query: "is:suspicious", limit: 1000, fields: ["mid"] }).results.map((r) => r.mid));
  assert.ok(!suspicious.has(corpus.facts.preheader[0].mid), "DMARC-authenticated preheader is not suspicious");
  for (const s of corpus.facts.spoofed) assert.ok(suspicious.has(s.mid), "forged own address (SPF fail, no DMARC pass) is suspicious");
  for (const i of corpus.facts.injections) {
    const id = idByMid(db, i.mid);
    if (id) assert.ok(suspicious.has(i.mid), `injection (${i.technique}) stays suspicious`);
  }
  const r = search(db, { query: `mid:${corpus.facts.preheader[0].mid}`, fields: ["warning"] }).results[0];
  assert.equal(r.warning, null);
});

test("server-side spam folders with unusual names are not indexed", () => {
  const { db, corpus } = env;
  for (const s of corpus.facts.serverSpam) assert.equal(idByMid(db, s.mid), undefined);
  const f = db.prepare("SELECT type, indexed FROM folders WHERE path = '/Filter/+spamverdacht'").get();
  assert.deepEqual({ ...f }, { type: "junk", indexed: 0 });
});

test("threads without References: same subject + shared participant joins, strangers stay apart", async () => {
  const { db, corpus } = env;
  const { rethreadAll } = await import("../../src/threading.js");
  const check = () => {
    const tid = (mid) => db.prepare("SELECT thread_id FROM messages WHERE mid = ?").get(mid).thread_id;
    const [a, b, c, d] = corpus.facts.hike.conversation.map(tid);
    assert.equal(a, b, "reply without References joins the original");
    assert.equal(a, c, "reply referencing a message not in the index joins too");
    assert.equal(a, d, "and so does the reply to that reply");
    assert.notEqual(tid(corpus.facts.hike.unrelated), a, "same subject from someone else a year later stays apart");
    const fragen = db.prepare("SELECT DISTINCT thread_id FROM messages WHERE subject = 'Re: Frage zum Angebot'").all();
    assert.equal(fragen.length, 2, "two people answering 'Frage zum Angebot' are different threads");
  };
  check(); // incremental (during sync)
  const before = db.prepare("SELECT id, thread_id FROM messages ORDER BY id").all().map((r) => `${r.id}:${r.thread_id}`);
  rethreadAll(db); // full recomputation gives the same result
  check();
  const after = db.prepare("SELECT id, thread_id FROM messages ORDER BY id").all().map((r) => `${r.id}:${r.thread_id}`);
  const diff = after.filter((x, i) => x !== before[i]);
  assert.ok(diff.length <= 2, `rethread agrees with incremental threading (${diff.length} differences)`);
});

test("count by two keys: sent/received per year", () => {
  const { db } = env;
  const r = count(db, { by: "year,direction" });
  const sum = r.groups.reduce((a, g) => a + g.count, 0);
  assert.equal(sum, r.total);
  const sent = r.groups.filter((g) => g.direction === "sent").reduce((a, g) => a + g.count, 0);
  assert.equal(sent, count(db, { query: "from:me" }).total);
  assert.deepEqual(r.groups.map((g) => g.year), [...r.groups.map((g) => g.year)].sort());
  assert.throws(() => count(db, { by: "year,year" }), /must differ/);
  assert.throws(() => count(db, { by: "year,bogus" }), /Cannot group by "bogus"/);
});

test("threads: long conversations I took part in; all conversations with a person", () => {
  const { db, corpus } = env;
  const long = threads(db, { minMessages: 4, mine: true, limit: 500 });
  assert.ok(long.total > 0);
  for (const t of long.threads) {
    assert.ok(t.messages >= 4 && t.by_me >= 1);
    assert.ok(t.first <= t.last);
    assert.ok(!t.participants.some((p) => /anna\.schmidt@firma|anna@privat/.test(p)), "the user is not listed as a participant");
    assert.equal(db.prepare("SELECT count(DISTINCT mid) n FROM messages WHERE thread_id = ?").get(t.thread).n, t.messages);
  }
  const counts = long.threads.map((t) => t.last);
  assert.deepEqual(counts, [...counts].sort().reverse(), "latest activity first");
  const withP = threads(db, { query: "with:j.mueller", sort: "first", limit: 500 });
  assert.ok(withP.total > 0);
  assert.ok(withP.threads.every((t) => t.participants.some((p) => p.includes("j.mueller@firma.example"))));
  const firsts = withP.threads.map((t) => t.first);
  assert.deepEqual(firsts, [...firsts].sort());
  const hike = threads(db, { query: "Wandergruss", limit: 10 });
  const conv = hike.threads.find((t) => t.messages === 4);
  assert.ok(conv, "the hiking conversation is one thread of four");
  assert.equal(conv.by_me, 2);
  assert.equal(threads(db, { query: "Wandergruss", mine: true }).total, 1);
});

test("folder rename is a move, not delete + re-download", async () => {
  const { db, h, resync } = env;
  const before = db.prepare("SELECT count(*) n FROM messages WHERE folder_id = 'account1://Projekte/Donner'").get().n;
  assert.ok(before > 0);
  const raw = h.tb.calls.getRaw;
  const f = h.tb.folders.get("account1://Projekte/Donner");
  h.tb.folders.delete(f.id);
  const nf = h.tb.addFolder("account1", { path: "/Projekte/Donner-2026", name: "Donner-2026", type: null });
  for (const r of h.tb.msgs.values()) if (r.folderId === f.id) r.folderId = nf.id;
  const s = await resync();
  assert.equal(s.moved, before);
  assert.equal(s.removed, 0);
  assert.equal(h.tb.calls.getRaw, raw);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE folder_id = ?").get(nf.id).n, before);
  assert.equal(db.prepare("SELECT count(*) n FROM folders WHERE id = 'account1://Projekte/Donner'").get().n, 0);
});

test("excluding a folder later purges its messages", async () => {
  const { db, bridge, cfg } = env;
  const cfg2 = structuredClone(cfg);
  cfg2.index.excludeFolders = ["Privat/Newsletter"];
  const before = db.prepare("SELECT count(*) n FROM messages WHERE folder_id = 'account2://Newsletter'").get().n;
  assert.ok(before > 0);
  const s = await sync({ db, bridge, cfg: cfg2 });
  assert.equal(s.removed, before);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE folder_id = 'account2://Newsletter'").get().n, 0);
  await sync({ db, bridge, cfg }); // re-include for later tests
});

test("disconnected Thunderbird: clear error, index still readable", async () => {
  const { h, resync, db } = env;
  await h.disconnect();
  await assert.rejects(resync(), (e) => e.code === "EXTENSION_DISCONNECTED");
  assert.ok(search(db, { query: "rechnung" }).total > 0);
  await h.reconnect();
});

test("status reports coverage", () => {
  const s = status(env.db, env.dbPath);
  assert.ok(s.messages > 0);
  assert.equal(s.content.full + (s.content.parts || 0), s.messages);
  assert.ok(s.folders.some((f) => !f.indexed));
});

test("interrupted sync resumes where it stopped", async () => {
  const x = await setupIndexed({ count: 150, sync: false, seed: 9 });
  try {
    const ac = new AbortController();
    let seen = 0;
    const s1 = await x.resync({
      signal: ac.signal,
      onProgress: (ev) => {
        if (ev.phase === "content" && ++seen === 3) ac.abort();
      },
    });
    assert.equal(s1.aborted, true);
    assert.ok(s1.pending > 0);
    const s2 = await x.resync();
    assert.equal(s2.pending, 0);
    assert.equal(s2.aborted, false);
    const n = x.db.prepare("SELECT count(*) n FROM messages WHERE content_state = 'full'").get().n;
    assert.ok(n >= 140);
  } finally {
    await x.cleanup();
  }
});

test("bridge auth token is sent and required", async () => {
  const x = await setupIndexed({ count: 30, sync: false, seed: 5, authToken: "t0ken" });
  try {
    const s = await x.resync();
    assert.ok(s.added > 0);
    const dir = tempDir();
    const noAuthCfg = testConfig({ ...x.h.bridge, authToken: null });
    const db2 = openDb(join(dir, "i.sqlite"));
    await assert.rejects(sync({ db: db2, bridge: new BridgeClient(noAuthCfg.bridge), cfg: noAuthCfg }), (e) => e.code === "AUTH_REQUIRED");
    db2.close();
  } finally {
    await x.cleanup();
  }
});

test("headers-only mode, then bodies later", async () => {
  const x = await setupIndexed({ count: 60, sync: false, seed: 3 });
  try {
    const s1 = await x.resync({ bodies: false });
    assert.ok(s1.added > 0);
    assert.equal(x.db.prepare("SELECT count(*) n FROM messages WHERE content_state = 'headers'").get().n, s1.added);
    assert.ok(search(x.db, { query: "rechnung" }).total > 0, "subjects are searchable without bodies");
  } finally {
    await x.cleanup();
  }
});

test("Thunderbird closing mid-sync: error, partial progress kept, next sync completes", async () => {
  const x = await setupIndexed({ count: 150, sync: false, seed: 13 });
  try {
    let disconnecting = null;
    let seen = 0;
    await assert.rejects(
      x.resync({
        onProgress: (ev) => {
          if (ev.phase === "content" && ++seen === 3 && !disconnecting) disconnecting = x.h.disconnect();
        },
      }),
      (e) => ["EXTENSION_DISCONNECTED", "BRIDGE_UNREACHABLE", "THUNDERBIRD_ERROR", "TIMEOUT"].includes(e.code)
    );
    await disconnecting;
    const done = x.db.prepare("SELECT count(*) n FROM messages WHERE content_state = 'full'").get().n;
    assert.ok(done > 0, "fetched content was committed");
    await x.h.reconnect();
    const s = await x.resync();
    assert.equal(s.pending, 0);
  } finally {
    await x.cleanup();
  }
});
