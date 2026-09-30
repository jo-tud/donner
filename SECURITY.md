# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's
[security advisories](https://github.com/jo-tud/donner/security/advisories/new) instead of opening a
public issue. Include a description, affected version and, if possible, a reproduction. You should get
an answer within a week. Fixes are released as soon as possible and credited unless you prefer otherwise.

Supported versions: the latest release.

## Threat model (summary)

donner indexes a user's mail for local AI agents. The detailed analysis, including the results of
the pre-release review, is in [docs/SECURITY-ANALYSIS.md](docs/SECURITY-ANALYSIS.md).

**Assets:** the content of the user's mailbox (in the index file), the thunderbird-cli bridge token,
the integrity of actions agents take on the user's behalf.

**Trust boundaries**

| Source | Trusted? | Handling |
|---|---|---|
| Email content (headers, bodies, attachments, file names) | **No** — anyone can send mail | parsed with bounded extractors; hidden HTML, comments and invisible Unicode removed; flagged; never executed |
| AI agent calling donner | Partially — it may have been manipulated by mail it read | donner is read-only; SQL sandboxed; no write/send/delete capability |
| Local user and processes running as that user | Yes | same trust as the user's Thunderbird profile |
| thunderbird-cli bridge | Yes (localhost, optional bearer token) | only read routes are used |
| Embedding service | Local by default; remote only with explicit opt-in | mail text is sent to it |

**Out of scope:** attackers with the user's OS account (they can read the Thunderbird profile anyway),
vulnerabilities in Thunderbird or thunderbird-cli themselves, and the agent's own decisions — donner
provides signals and read-only data, the agent (and the user) decide what to do with them.

## Hardening overview

- Index, WAL/SHM, lock and saved attachments are created with mode `0600` in a `0700` directory.
- No network access except the configured bridge (loopback by default) and an opt-in embedding endpoint (loopback unless `allowRemote`).
- SQL: single read-only statement, keyword/structure check on a literal-free skeleton (no parameters),
  separate process with an address-space limit, read-only connection with `query_only`, capped blob
  functions, one query at a time, timeout, row and cell limits.
- MCP: strict argument validation, bounded limits, errors returned as tool errors, stdout reserved for protocol.
- Mail parsing runs in worker threads with a per-message deadline and memory cap; the HTML tokenizer and
  text helpers are linear-time (ReDoS regression tests).
- Attachment extraction: size caps, bounded decompression (zip bombs), built-in PDF extractor by default
  (`pdftotext` is opt-in, with timeout), no shell.
- Human output strips terminal control characters from mail content.
- One runtime dependency (`postal-mime`, no transitive dependencies, no install scripts).
