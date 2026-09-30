# Vendored thunderbird-cli files (test only)

Unmodified copies of files from [thunderbird-cli](https://github.com/vitalio-sh/thunderbird-cli)
at commit `465613d` (release 1.1.0 / extension 2.1.0), MIT licensed — see `LICENSE` in this folder.

- `bridge.js` — the tb-bridge daemon (run as a child process by the test harness)
- `background.js`, `thread-utils.js` — the Thunderbird extension (run in a `vm` context on top of a simulated `messenger` API)

They are used only by `test/fixtures/harness.js` and are not part of the published package.
