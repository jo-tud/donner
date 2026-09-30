# Architecture

## Why an index layer

thunderbird-cli exposes Thunderbird's WebExtension API over a local bridge. Every call goes
CLI → HTTP → bridge → WebSocket → extension → `messenger.*`, and `messages.query()` scans folders
in Thunderbird's JavaScript. That is fine for actions and point lookups, but slow for search,
and impossible for questions that need many messages at once (totals, per-month counts, "who
writes me most", attachment contents). Agents would have to pull thousands of messages through
their context window.

donner keeps a local copy of the *searchable text* in SQLite with an FTS5 index. Agents ask
small, precise questions and get compact answers; Thunderbird stays the source of truth and
the only component that writes mail.

We evaluated the alternatives:

| Option | Verdict |
|---|---|
| Live queries through the extension only (all existing Thunderbird MCP servers) | simple, but slow full-text search, no aggregation, IMAP bodies often missing |
| Read Thunderbird's profile directly (mbox, Mork `.msf`, Gloda `global-messages-db.sqlite`) | fast, but undocumented formats, Gloda uses a custom tokenizer (`mozporter`) other SQLite builds cannot query, breaks with Thunderbird's upcoming "Panorama" database |
| **Own index fed through thunderbird-cli (donner)** | fast, documented schema, works for IMAP/POP/local, survives Thunderbird changes as long as the WebExtension API does |

CLI first, MCP second: CLI tools cost no context until used, compose with pipes and scripts,
and are what coding agents are best at. The MCP server is a thin layer over the same functions
for clients without a shell.

## Components

```
bin/donner.js          entry point
src/cli.js             commands, argument parsing, human/JSON output
src/sync.js            incremental indexer
src/bridge.js          HTTP client for tb-bridge (read-only routes)
src/mime.js            raw RFC 822 → document (postal-mime), auth results, body choice
src/html.js            HTML → text, hidden-content removal
src/text.js            sanitising, quote/signature splitting, addresses, subjects
src/attachments.js     text extraction: PDF (pdf.js), Office (zip.js), ICS, VCF, HTML, EML
src/db.js              schema, migrations, connection handling
src/query.js           Gmail-style query language → FTS5 + SQL
src/ops.js             search, count, show, thread, threads, people, status, resolve
src/threading.js       conversation threading (references, subject + participant fallback)
src/identity.js        the user's addresses, contacts, sender-authentication verdict
src/sql.js             read-only SQL (validation + child process runner)
src/semantic.js        optional embeddings (Ollama / OpenAI-compatible), hybrid ranking
src/parse-pool.js      worker threads that parse untrusted mail with deadlines and memory caps
src/mcp.js             MCP stdio server (JSON-RPC 2.0), background auto-sync
src/service.js         systemd / launchd service files
```

Only one runtime dependency: [`postal-mime`](https://github.com/postalsys/postal-mime) (MIT-0, no
dependencies) for MIME parsing. SQLite is Node's built-in `node:sqlite` (FTS5 enabled in official builds).

## Data model

```
accounts(id, name, type, email)
folders(id, account_id, path, name, type, total, unread, indexed, synced_at, reconciled_at, sync_total, sync_unread, error)
messages(id, mid, folder_id, account_id, tb_id, tb_epoch, date, from_name, from_addr, from_fold, to_json, cc_json,
         bcc_json, reply_to, subject, subject_norm, thread_id, in_reply_to, list_id, size, read, flagged, junk, tags,
         attachment_count, body, quoted, snippet, people, att_text, content_state, content_error,
         auth_json, auth_verdict, hidden_removed, indexed_at, updated_at)
identities(addr, name, source, account_id)       -- all of the user's addresses (account | config | sent)
contacts(addr, sent, last_sent)                  -- addresses the user has written to
events(message_id, start, end, last_start, summary, location, organizer, method, status, rrule, uid)
addresses(message_id, role, name, addr)          -- aggregation by person
attachments(message_id, idx, part_name, filename, content_type, size, text, text_state)
refs(message_id, ref_mid)                         -- References / In-Reply-To
embeddings(message_id, model, dim, vec)
messages_fts  FTS5(subject, people, body, quoted, att_text)  external content = messages
mail          VIEW with readable dates and folder/account names
```

- One row per message *per folder* (Thunderbird can hold copies). Search results and counts fold
  duplicates by Message-ID.
- `body` is the author's own text; `quoted` holds reply history and signature. Both are indexed,
  with column weights subject 6, people 3, body 1, attachments 0.8, quoted 0.15 — a thread's
  history does not drown the message that actually discusses a topic.
- Tokenizer `unicode61 remove_diacritics 2` with prefix indexes 2–4. The FTS triggers pass every
  column through `donner_de()` (ä→ae, ö→oe, ü→ue, ß→ss; same number of tokens, so highlighting
  stays aligned), and queries apply the same transform: `müller` = `mueller`, `poet` ≠ `pot`.
  The FTS index must therefore never be rebuilt with `'rebuild'` (which reads the raw columns);
  migrations use `'delete-all'` and re-insert through the function.
- "Me" is the `identities` table: every identity of every account, `index.myAddresses`, and
  senders found in folders of type *sent* (at any depth). `auth_verdict` is `pass` when DMARC
  passes, `fail` when DMARC fails or, without DMARC, when nothing passes and something fails.

## Sync

```
bridgeStatus / health
epoch check        — sample 3 stored tb_ids; if they now point to other messages, bump the epoch
accounts, folders  — upsert; excluded folders are purged; vanished folders become "gone" candidates
choose folders     — changed total/unread, never reconciled, >24h since reconcile, pending content, or --full
list headers       — /messages/list (≤ 20 000) or date-windowed /messages/search (bisected when a window is too large)
reconcile          — per folder by Message-ID: flag/tag updates, new candidates, gone candidates
moves              — new ∩ gone by Message-ID → UPDATE folder (no download)
insert / delete    — remaining new rows (content_state = pending) / gone rows (cascade to FTS, refs, attachments)
content            — pending rows newest first, N concurrent fetches:
                       size ≤ 8 MB → GET /messages/:id/raw → postal-mime → text, refs, auth, attachments
                       larger     → GET /messages/:id (Thunderbird's decoded parts) + small attachments
                                    one by one via POST /messages/:id/attachment
                       copy of an already indexed Message-ID → copy content, no download
                     committed in batches of 50; Ctrl-C finishes the batch and exits
threads            — union of the message's References/In-Reply-To, messages referencing it, same Message-ID;
                     when the message's own references resolve to nothing: same normalised subject within
                     ±60 days, one of the two a reply, and a shared participant other than the user
identities         — refreshed at the start (accounts, config) and end (sent folders) of every sync;
                     contacts recomputed at the end
```

Schema upgrades run on first open (also from read-only callers, through a short-lived writable
connection) inside one transaction; data that newer extraction code handles differently is marked
`pending` and re-read by the next sync (`REPARSE_SETS` in `db.js`, also `donner sync --reparse`).

A lock file next to the index prevents concurrent writers. SQLite runs in WAL mode, so searches
work while a sync is running.

### Thunderbird message ids

WebExtension message ids are assigned per Thunderbird session. donner therefore never exposes
its own ids as Thunderbird ids: `tb_id` is stored together with an epoch, and `donner resolve`
verifies (`GET /messages/:id/headers` must return the same Message-ID) or re-finds the message
(`messages.query({headerMessageId})`) before returning an id for an action.

## Query language

`src/query.js` tokenises the query (`-`, `NOT`, `field:`, quotes, groups), parses it into an AST
(OR binds tighter than AND), turns free words into an FTS5 expression (`"word"*`, phrases, `OR`
groups) and operators into parameterised SQL predicates. Negated words become `id NOT IN (SELECT rowid FROM messages_fts WHERE … MATCH ?)`.
All user input is passed as bound parameters; FTS5 terms are always double-quoted.

## Security boundaries

- **Hostile mail content** → `html.js` removes hidden elements/comments/scripts, `text.js` removes
  invisible Unicode, attachment extractors are size- and time-bounded, terminal output strips
  control characters.
- **Agents** → read-only tools; SQL restricted to single read-only statements in a child process
  with a read-only connection, `query_only`, timeout and output caps.
- **Confidentiality** → private file modes, no network except the local bridge and an opt-in local
  embedding endpoint.

See [SECURITY-ANALYSIS.md](SECURITY-ANALYSIS.md).

## Testing

`test/fixtures/fake-thunderbird.js` implements the subset of the `messenger.*` API that
thunderbird-cli uses (accounts, folders, paginated lists, query, get/getFull/getRaw, attachments,
per-session ids). `test/fixtures/harness.js` runs thunderbird-cli's **real** `bridge.js` (child
process) and **real** `background.js` (in a `vm` context) on top of it. For benchmarks the fake
Thunderbird and the extension run in their own process (`test/fixtures/tb-process.js`), as in reality. `test/fixtures/corpus.js`
generates a deterministic German/English mailbox with threads, PDF invoices, Office documents,
calendar invites, newsletters, prompt-injection mails, charset edge cases, duplicates and a
message without Message-ID.
