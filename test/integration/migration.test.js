// Upgrading an index built by donner 0.1 (schema 1) to schema 2.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupIndexed, idByMid } from "../helpers.js";
import { openDb, getMeta } from "../../src/db.js";
import { sync } from "../../src/sync.js";
import { search, count } from "../../src/ops.js";

let env;
before(async () => {
  env = await setupIndexed({ count: 250, seed: 11 });
});
after(async () => {
  await env?.cleanup();
});

// Turn a freshly built schema-2 index back into what donner 0.1 wrote.
function downgradeToV1(db) {
  db.exec(`
    DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_ad; DROP TRIGGER messages_fts_au;
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text)
      VALUES (new.id, new.subject, new.people, new.body, new.quoted, new.att_text);
    END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, subject, people, body, quoted, att_text)
      VALUES ('delete', old.id, old.subject, old.people, old.body, old.quoted, old.att_text);
    END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE OF subject, people, body, quoted, att_text ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, subject, people, body, quoted, att_text)
      VALUES ('delete', old.id, old.subject, old.people, old.body, old.quoted, old.att_text);
      INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text)
      VALUES (new.id, new.subject, new.people, new.body, new.quoted, new.att_text);
    END;
    INSERT INTO messages_fts(messages_fts) VALUES('delete-all');
    INSERT INTO messages_fts(rowid, subject, people, body, quoted, att_text) SELECT id, subject, people, body, quoted, att_text FROM messages;
    DROP TABLE identities; DROP TABLE contacts;
    ALTER TABLE messages DROP COLUMN auth_verdict;
    DROP INDEX events_last; DROP INDEX events_uid;
    ALTER TABLE events DROP COLUMN sequence; ALTER TABLE events DROP COLUMN recurrence_id;
    ALTER TABLE events DROP COLUMN parsed_last; ALTER TABLE events DROP COLUMN active; ALTER TABLE events DROP COLUMN next_start;
    ALTER TABLE events DROP COLUMN method; ALTER TABLE events DROP COLUMN status; ALTER TABLE events DROP COLUMN rrule;
    ALTER TABLE events DROP COLUMN uid; ALTER TABLE events DROP COLUMN last_start;
    UPDATE messages SET from_fold = 'old-fold', thread_id = id;
    UPDATE meta SET value = '1' WHERE key = 'schema_version';
  `);
}

test("a schema-1 index is upgraded on first open, then completed by the next sync", async () => {
  const { corpus, dbPath } = env;
  // 0.1 lost the text of MJML newsletters: simulate an empty body with hidden content.
  const victim = idByMid(env.db, corpus.facts.preheader[0].mid);
  env.db.prepare("UPDATE messages SET body = '', snippet = '', hidden_removed = 1 WHERE id = ?").run(victim);
  const muellerBefore = search(env.db, { query: "Mueller" }).total;
  downgradeToV1(env.db);
  env.db.close();

  // Readers (CLI search, MCP server) trigger the upgrade transparently.
  const ro = openDb(dbPath, { readOnly: true });
  assert.equal(getMeta(ro, "schema_version"), "4");
  assert.equal(search(ro, { query: "Müller" }).total, muellerBefore, "umlaut index rebuilt");
  assert.equal(search(ro, { query: "Mueller" }).total, muellerBefore);
  assert.ok(count(ro, { query: "from:me" }).total > 0, "identities filled from accounts and sent folders");
  assert.equal(ro.prepare("SELECT count(*) n FROM messages WHERE from_fold = 'old-fold'").get().n, 0);
  assert.equal(ro.prepare("SELECT content_state FROM messages WHERE id = ?").get(victim).content_state, "pending", "affected message marked for re-reading");
  const pending = ro.prepare("SELECT count(*) n FROM messages WHERE content_state = 'pending'").get().n;
  const all = ro.prepare("SELECT count(*) n FROM messages").get().n;
  assert.ok(pending > 0 && pending < all / 2, `targeted, not everything (${pending}/${all})`);
  assert.equal(getMeta(ro, "rethread"), "1");
  ro.close();

  const db = openDb(dbPath);
  try {
    const stats = await sync({ db, bridge: env.bridge, cfg: env.cfg });
    assert.equal(stats.pending, 0);
    assert.equal(getMeta(db, "rethread"), null, "threads recomputed");
    assert.ok(db.prepare("SELECT count(DISTINCT thread_id) n FROM messages").get().n < all, "threads re-joined");
    assert.match(db.prepare("SELECT body FROM messages WHERE id = ?").get(victim).body, /Paketbote/, "text restored");
    assert.ok(db.prepare("SELECT count(*) n FROM events WHERE method = 'REQUEST'").get().n > 0, "calendar data re-read");
    assert.equal(search(db, { query: "Paketbote" }).total, 1);
  } finally {
    db.close();
  }
  env.db = openDb(dbPath); // for cleanup
});

test("a schema-2 index (donner 0.2) gets identity ids and calendar versions, re-reading only affected mail", async () => {
  const { dbPath } = env;
  env.db.exec(`ALTER TABLE identities DROP COLUMN tb_identity; DROP INDEX events_uid;
    ALTER TABLE events DROP COLUMN sequence; ALTER TABLE events DROP COLUMN recurrence_id;
    ALTER TABLE events DROP COLUMN parsed_last; ALTER TABLE events DROP COLUMN active; ALTER TABLE events DROP COLUMN next_start;
    UPDATE meta SET value = '2' WHERE key = 'schema_version';`);
  env.db.close();
  const db = openDb(dbPath);
  try {
    assert.equal(getMeta(db, "schema_version"), "4");
    const pending = db.prepare("SELECT count(*) n FROM messages WHERE content_state = 'pending'").get().n;
    const all = db.prepare("SELECT count(*) n FROM messages").get().n;
    assert.ok(pending > 0 && pending < all / 3, `targeted re-read (${pending}/${all})`);
    await sync({ db, bridge: env.bridge, cfg: env.cfg });
    assert.ok(db.prepare("SELECT count(*) n FROM events WHERE sequence IS NOT NULL").get().n > 0, "calendar versions re-read");
    assert.ok(db.prepare("SELECT count(*) n FROM identities WHERE tb_identity IS NOT NULL").get().n > 0);
  } finally {
    db.close();
  }
  env.db = openDb(dbPath);
});
