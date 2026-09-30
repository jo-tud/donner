// Try donner without Thunderbird: starts the real thunderbird-cli bridge with a simulated
// Thunderbird holding a generated mailbox.
//
//   npm run demo            # then, in another terminal, run the printed commands

import { generateCorpus } from "./fixtures/corpus.js";
import { startHarness } from "./fixtures/harness.js";

const count = Number(process.argv[2] || process.env.DEMO_COUNT || 1500);
const corpus = generateCorpus({ count, seed: 7 });
const h = await startHarness({ corpus });
const port = h.bridge.port;

process.stdout.write(`Simulated Thunderbird with ${corpus.messages.length} messages in ${corpus.accounts.length} accounts.
Bridge: http://127.0.0.1:${port}

In another terminal (uses a separate demo index, your real one is not touched):

  export DONNER_BRIDGE_PORT=${port} DONNER_DB=/tmp/donner-demo.sqlite
  donner sync
  donner search rechnung
  donner count has:pdf --by month
  donner people
  donner thread <id>

Press Ctrl-C to stop.
`);

if (process.env.DEMO_READY_FILE) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.DEMO_READY_FILE, String(port));
}

const stop = async () => {
  await h.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
