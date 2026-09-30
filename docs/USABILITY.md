# Usability analysis

Status: pre-release study for 0.1.0 and field test on a real mailbox for 0.2.0 (September 2026).

## Method

An independent tester who had not seen the code installed donner like a user would
(`npm install -g` into a prefix) and worked against the demo: the real thunderbird-cli bridge and
extension on a simulated Thunderbird with 1,500 German/English mails. The tester took two roles:

1. **End user** who already runs Thunderbird and thunderbird-cli: first run, errors, help texts.
2. **AI agent** using only the CLI JSON, `SKILL.md` and the MCP server.

The same realistic questions were answered in both roles, for example:
- "How much did I pay Stadtwerke in 2025?" (amounts only in PDF attachments)
- "Summarise the discussion about Lieferverzug"
- "Who writes me most?"
- "When did I last hear from Björn?"
- "Which mails look like phishing?"
- "What meetings am I invited to?"
- "Find the Excel calculation about the search index"

For each, the tester recorded the commands, the friction and the token cost. Every finding was
then fixed and covered by a test where possible.

## What worked from the start

- Install in under a second: no native build, one dependency.
- `doctor` explains what is missing and what to do.
- Errors come as JSON with a `code` and a `hint`, and distinct exit codes.
- The first sync of 1,500 mails took 3 s, with a progress bar.
- A second, concurrent sync is refused cleanly.
- Search works while the bridge or Thunderbird is down; queries answer in about 100 ms including process start.
- Free-text umlaut folding, thread output without repeated quotes, readable terminal output.
- PDF/XLSX/ICS text is searchable.
- The untrusted-content notice and trust signals are present.

## Findings and changes

| # | Observation | Impact | Change |
|---|---|---|---|
| U1 | `donner search rechnung -newsletter` / `-from:x` as separate arguments were read as short options (`-n ewsletter`), silently dropped or rejected | High: wrong answers | Only exact known flags are options; everything else is a query term. Global options may precede the command |
| U2 | Negated filters on nullable columns dropped mail: `-in:sent` returned 636 instead of 1,032 (folders without a type vanished); same for `-list:`, `-account:` | High: wrong counts | NULL-safe negation (`NOT COALESCE(…, 0)`), a test for each negated operator |
| U3 | `OR` only worked between plain words, and parentheses were silently misparsed. `from:x OR to:x Y` → 0 results; the skill recommended exactly this | High | Real parser with groups; OR binds tighter than AND (Gmail semantics); new `with:x` (sender or recipient). Skill recipe fixed |
| U4 | Participant filters were not umlaut/case tolerant: `from:bjoern`, `from:BJÖRN`, `people bjoern` → 0 | High | Folded name/address columns (ö=oe=o, ß=ss, case) for `from:`/`to:`/`cc:`/`with:` and `people` |
| U5 | `people` showed one `last` date. It answered "last contact" instead of "last heard from", which was wrong for "when did I last hear from Björn" | Medium | `last_received` and `last_sent` |
| U6 | Folder names differed across outputs; `folder:Privat/Rechnungen` (as displayed) → 0 | Medium | The displayed `Account/Path` form is accepted |
| U7 | Invalid input accepted silently: unknown operators became words, `after:2025-13` rolled over, `-n 0`, non-numeric ports, unknown help topics | Medium | Unknown operators rejected, with a hint to quote them for a literal search. Calendar dates validated; limits must be ≥1; ports validated; did-you-mean for typos |
| U8 | Phishing triage needed SQL: `is:hidden` mostly matched newsletter preheaders; trust data only in `show` | Medium | `is:suspicious` (auth failed, or hidden text outside mailing lists), `is:authfail`, `warning` field in search results |
| U9 | Meeting dates were not queryable (only the mail date) | Medium | `events` table from ICS parts; `has:invite`, `event_after:`, `event_before:`; `show` lists events |
| U10 | Topic across several threads needed one call per thread | Low | `count --by thread` returns subject and last date |
| U11 | Output shape inconsistencies: `show 1` flat vs `show 1 2` list; requested `--fields` omitted when false; `status` JSON always carried ~2 KB of folders; `doctor` had `ok` twice | Low | `show` always returns `messages[]`; explicitly requested fields are always present; folders only with `--folders`; `doctor` reports `healthy` |
| U12 | Near-identical results (monthly invoices) appeared in random date order under relevance sort | Low | Relevance is quantised; ties sort by date |
| U13 | Help, skill and MCP description disagreed; several operators were undocumented; the skill's error table was incomplete | Medium for agents | One operator reference (`QUERY_HELP`) feeds CLI help and MCP; a test checks README, skill and MCP mention every operator; error table completed |
| U14 | German search limits undocumented: "index" doesn't find "Suchindex"; no stemming | Medium | Documented in help, README and skill, with advice (stems, OR with English) |
| U15 | `service` unit ignored `DONNER_DB`/port variables; `attachment --save dir/` failed | Low | Service files carry the relevant environment; saving into a directory uses the original (sanitised) file name |
| U16 | No README; the MCP setup needed absolute paths for Claude Desktop | High for onboarding | README with install, quick start, query reference, agent setup (incl. absolute-path note), config, security, limitations |

## Field test (0.2.0)

donner 0.1 was used with Claude Desktop and Claude Code on a real mailbox of about 70,000 messages
spanning many years, with two IMAP accounts and a large local archive. First sync took about
12 minutes; searches 60–250 ms, `people` under a second, `thread` 60 ms. The SQL guard, input
validation, `resolve` and `doctor` held up. The synthetic corpus had hidden several problems that
only real mail showed:

| # | Observation (real mailbox) | Impact | Change |
|---|---|---|---|
| F1 | Newsletters built with MJML (a bank's newsletters, travel and shop mailings) had empty bodies: `font-size:0` on a wrapper removed the whole subtree although children reset it. About 1,000 empty bodies without attachments | High: mail invisible to search | CSS inheritance like a browser: font size, colour and visibility are inherited and can be reset; only display/opacity/clip/zero-size overflow/off-screen remove subtrees |
| F2 | Built-in PDF extractor returned nothing for about 3,000 PDFs; ~70 % had text (LibreOffice, ReportLab ASCII85, QuickReports LZW, FOP) | High: invoices not findable | pdftotext by default when installed (doctor recommends installing it); built-in extractor learned ASCII85/ASCIIHex/LZW, object streams, indirect fonts |
| F3 | `from:me` knew one address per account and found only a fraction of the user's own mail; the user's own address appeared as top correspondent under a spam display name | High: wrong answers | All identities, senders in sent folders at any depth, `myAddresses`; own addresses never listed as correspondents; forged own address (auth fail) is not "me"; `status` shows the list |
| F4 | `is:suspicious`/`warning` matched about a third of all mail (preheaders of shop and payment mails, `dkim=fail` with `dmarc=pass`) | Medium: signal lost in noise | DMARC decides authentication; hidden text only counts for senders that are neither DMARC-authenticated nor contacts; providers that write one result header per method are merged |
| F5 | `müller` did not find *Mueller*; ASCII queries matched wrong variants (`poet` returned ~50× too many hits) | Medium | Index stores ä/ö/ü/ß as ae/oe/ue/ss; queries use the same transform, no other variants |
| F6 | `AND`/`NOT` searched as words; `since:2025-01 until:2025-01` → 0 | Medium | Uppercase `AND` no-op, `NOT` negates; `until:` inclusive |
| F7 | Many replies without References; conversations split into several threads | Medium | Subject + shared participant + time fallback, also for references to missing messages; one-time re-threading |
| F8 | Calendar: recurring meetings lost their rule, cancellations looked like invitations, time-zone definitions added noise, `has:invite` matched train tickets | Medium | Events only, METHOD/STATUS/RRULE stored; `has:invite` vs `has:event` vs `has:cancelled`; `--sort event` and an `event` field |
| F9 | Small attachments in mails over 8 MB marked `too_large` | Low | Fetched individually |
| F10 | Subjects with "�" (8-bit headers), some raw encoded words | Low | Windows-1252 fallback per header line; lenient encoded-word decoding |
| F11 | A nested server-side spam folder (`<account>/+spamverdacht`) was indexed | Low | Junk/trash/sent names recognised at any depth and with leading punctuation; `doctor` warns about spam-like indexed folders |
| F12 | Questions that needed SQL or many calls: long threads I took part in, sent vs received per year, all threads with a person with start date and participants | Medium for agents | `threads` / `mail_threads`; `count --by year,direction` |
| F13 | Index size ~10 KB/message instead of the documented 4 KB | Info | README states the range (synthetic 4–5 KB, attachment-heavy real mail ~10 KB) |

Upgrading keeps the index: schema 2 is applied on first open and the next sync re-reads only the
messages that the new code handles differently (empty or hidden-content bodies, failed attachments,
calendar mails, broken headers, incomplete authentication results, large messages).

## Second field test (0.3.0)

Confirmed fixed on the same mailbox: MJML newsletters (empty bodies reduced by ~60 %, the rest
genuinely empty), PDFs (~80 % fewer without text; a sample of the rest were scans), names in
`people`, umlauts, `AND`/`NOT`, `until:`, `is:suspicious` (a third → an eighth of all mail),
calendar noise, attachments of large mails, broken headers, spam folder, thread fragmentation.
The new `mail_threads` / `count --by year,direction` answered the three questions that needed SQL
before — `mail_sql` was not needed once in this round.

| # | Observation | Impact | Change |
|---|---|---|---|
| G1 | "Which invitations do I have in the next weeks?" returned ~70 results; years-old series without end came first, the real ones near the end; hundreds of events had several versions | High | Newest version per event, cancellations applied, open-ended series end a year after their last update, sorting by next occurrence. For "appointments" the skill uses `has:event` (invitations, confirmations, tickets) |
| G2 | The most used own address (mail only in archive folders, not in sent folders) was unknown: `from:me` found less than half of the user's mail; sent counts per year, `by_me` and `people` wrong | High | `possibly_mine` in `status`/`mail_status` and a `doctor` warning with the config snippet; not applied automatically (other people can share a surname, spam forges names) |
| G3 | Duplicated/unclosed `<head>` swallowed the mail | Medium | Fixed |
| G4 | Bottom-posted replies had an empty body | Medium | Fixed |
| G5 | Authentication results written on a provider's internal hops were still incomplete; SPF softfail flagged old mail from known contacts | Medium | Provider-wide merge; softfail no longer fails |
| G6 | Queries felt slower | Unclear | A/B against 0.1.0: the new version was 10–25 % slower on aggregations; with a larger page cache and memory-mapped reads it is now faster than 0.1.0 everywhere |
| G7 | A conversation still split into 3 threads; doctor's spam hint generic; `Sent-1`/`sent-mail` not recognised | Low | Fixed |

## Third field test (0.3.0 confirmed)

All second-round items confirmed on the real mailbox after re-reading about half of it: exactly the
real upcoming invitations, sorted by next date; `has:event` additionally the train journey and a
doctor's appointment; the `<head>` and bottom-posting cases have text; empty bodies without
attachments halved again; the suggested own addresses were exactly the missing ones, and adding
them more than doubled `from:me`; `people` 3× and `to:me` 10× faster under the same load.

## Design decisions that came out of the study

- **Terminal vs. JSON by default.** Humans at a TTY get readable output. Pipes and agents get one JSON
  document with a stable envelope, the same convention as thunderbird-cli, so agents can use both tools
  without switching mental models.
- **Compact by default, exact on request.** Default search results leave out empty and false values to
  save tokens. As soon as `--fields` is given, the caller gets exactly those fields.
- **Few, coarse MCP tools** (ten, all read-only) instead of one tool per operation. The query language
  carries the expressiveness, and `mail_sql` is the escape hatch.
- **No hidden magic in ranking.** BM25 with column weights and a date tie-break is predictable; semantic
  search is opt-in and labelled as such.

## Open points

- A "why is this suspicious" field that names the reason per message (auth, hidden text, forged
  own address) would make triage faster.
- Per-occurrence expansion of recurring events (currently: "still occurring after X").
- Stemming / compound splitting for German would help recall but needs a dictionary. It is postponed
  in favour of documenting prefix search.
- A "why did this match" explanation per result (which column and term) would help agents choose what
  to read.
- A first-run wizard (`donner init`) could combine `doctor`, the first `sync` and the `skill install`.
  For now, `doctor` explains each step.
