// Worker thread: parses one raw message at a time (see parse-pool.js).

import { parentPort } from "node:worker_threads";
import { parseRawMessage } from "./mime.js";
import { extractAttachmentText } from "./attachments.js";

parentPort.on("message", async ({ id, raw, opts }) => {
  try {
    const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    // One attachment fetched on its own (from a message too large to download whole).
    const result = opts?.attachment
      ? await extractAttachmentText({ filename: opts.attachment.filename, mimeType: opts.attachment.contentType, content: buf }, { maxChars: opts.maxChars, maxBytes: opts.maxBytes, pdftotext: opts.pdftotext })
      : await parseRawMessage(buf, opts);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err).slice(0, 500) });
  }
});
