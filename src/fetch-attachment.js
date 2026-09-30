// Save an original attachment file, fetched live from Thunderbird.

import { writeFileSync } from "node:fs";
import PostalMime from "postal-mime";
import { resolve } from "./ops.js";
import { DonnerError } from "./errors.js";

export async function saveAttachment({ db, bridge, id, idx, target }) {
  const a = db.prepare("SELECT part_name, filename, size FROM attachments WHERE message_id = ? AND idx = ?").get(id, idx);
  if (!a) throw new DonnerError("NOT_FOUND", `Message ${id} has no attachment #${idx}.`);
  const r = await resolve(db, bridge, [id]);
  const tbId = r.resolved[0]?.tb_id;
  if (!tbId) throw new DonnerError("NOT_FOUND", r.resolved[0]?.error || "Message not found in Thunderbird.");
  let data;
  if (a.part_name) {
    data = (await bridge.attachment(tbId, a.part_name)).data;
  } else {
    const raw = await bridge.raw(tbId);
    const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
    const list = (email.attachments || []).filter((x) => !(x.related && /^image\//.test(x.mimeType)));
    const att = list[idx - 1];
    if (!att) throw new DonnerError("NOT_FOUND", "Attachment not found in the message source (did the message change?).");
    data = Buffer.from(att.content instanceof ArrayBuffer ? new Uint8Array(att.content) : att.content);
  }
  writeFileSync(target, data, { mode: 0o600 });
  return { path: target, bytes: data.length, filename: a.filename };
}
