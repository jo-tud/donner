// Child process: generated mailbox + FakeThunderbird + the real thunderbird-cli extension.
//   node tb-process.js <wsPort> <count> <seed>
import { generateCorpus } from "./corpus.js";
import { FakeThunderbird } from "./fake-thunderbird.js";
import { Extension } from "./harness.js";

const [wsPort, count, seed] = process.argv.slice(2).map(Number);
const tb = new FakeThunderbird(generateCorpus({ count, seed }));
new Extension(tb, wsPort);
process.on("SIGTERM", () => process.exit(0));
