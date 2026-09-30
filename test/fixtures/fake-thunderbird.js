// A fake Thunderbird: implements the subset of the MailExtension `messenger.*` API that the
// thunderbird-cli extension uses, backed by an in-memory mailbox. The *real* thunderbird-cli
// background.js runs on top of it (see harness.js), so donner is tested against the real
// extension router and bridge, with only Thunderbird itself simulated.
//
// Faithful quirks:
//  - message ids are handed out lazily per session and change after restart()
//  - lists are paginated (100 per page) via continueList()
//  - getRaw() returns a binary string

const PAGE = 100;

export class FakeThunderbird {
  constructor(corpus) {
    this.accounts = new Map();
    this.folders = new Map(); // folderId -> folder
    this.msgs = new Map(); // key -> message record {key, folderId, ...}
    this.nextKey = 1;
    this.session = 0;
    this.calls = { getRaw: 0, getFull: 0, list: 0, query: 0 };
    for (const a of corpus.accounts) {
      this.accounts.set(a.id, { ...a });
      for (const f of a.folders) this.addFolder(a.id, f);
    }
    for (const m of corpus.messages) this.addMessage(m);
    this.restart();
  }

  addFolder(accountId, { path, name, type }) {
    const id = `${accountId}:/${path}`;
    const f = { id, accountId, path, name, type, specialUse: type ? [type] : [] };
    this.folders.set(id, f);
    return f;
  }

  folderId(accountId, path) {
    return `${accountId}:/${path}`;
  }

  addMessage(m) {
    const folderId = this.folderId(m.accountId, m.folderPath);
    if (!this.folders.has(folderId)) throw new Error(`no folder ${folderId}`);
    const key = this.nextKey++;
    const rec = { key, folderId, raw: m.raw, meta: { ...m.meta }, bodyParts: m.bodyParts, attachments: m.attachments, text: m.text.toLowerCase() };
    this.msgs.set(key, rec);
    return rec;
  }

  /** Simulate a Thunderbird restart: all WebExtension message ids change. */
  restart() {
    this.session++;
    this.idByKey = new Map();
    this.keyById = new Map();
    // Start each session at a different offset so stale ids point at *other* messages.
    this.nextId = 1 + (this.session - 1) * 7;
    this.pages = new Map();
    this.nextPage = 1;
  }

  idFor(rec) {
    let id = this.idByKey.get(rec.key);
    if (id === undefined) {
      id = this.nextId++;
      this.idByKey.set(rec.key, id);
      this.keyById.set(id, rec.key);
    }
    return id;
  }

  recById(id) {
    const key = this.keyById.get(Number(id));
    const rec = key !== undefined ? this.msgs.get(key) : undefined;
    if (!rec) throw new Error(`Message not found: ${id}.`);
    return rec;
  }

  folderObj(f, withSub = false) {
    const o = { id: f.id, accountId: f.accountId, name: f.name, path: f.path, type: f.type || undefined, specialUse: f.specialUse, isRoot: f.path === "/" };
    if (withSub) o.subFolders = this.childFolders(f.accountId, f.path).map((c) => this.folderObj(c, true));
    return o;
  }

  childFolders(accountId, parentPath) {
    const prefix = parentPath === "/" ? "/" : parentPath + "/";
    return [...this.folders.values()].filter((f) => f.accountId === accountId && f.path !== "/" && f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"));
  }

  header(rec) {
    const f = this.folders.get(rec.folderId);
    return {
      id: this.idFor(rec),
      date: new Date(rec.meta.date),
      author: rec.meta.author,
      subject: rec.meta.subject,
      recipients: rec.meta.recipients,
      ccList: rec.meta.ccList,
      bccList: rec.meta.bccList,
      read: rec.meta.read,
      flagged: rec.meta.flagged,
      junk: rec.meta.junk,
      junkScore: rec.meta.junk ? 100 : 0,
      tags: [...rec.meta.tags],
      size: rec.meta.size,
      headerMessageId: rec.meta.headerMessageId,
      external: false,
      new: false,
      headersOnly: false,
      folder: this.folderObj(f),
    };
  }

  paginate(recs) {
    const headers = recs.map((r) => this.header(r));
    const first = headers.slice(0, PAGE);
    if (headers.length <= PAGE) return { id: null, messages: first };
    const id = `page-${this.nextPage++}`;
    this.pages.set(id, { rest: headers.slice(PAGE) });
    return { id, messages: first };
  }

  folderMessages(folderId) {
    return [...this.msgs.values()].filter((r) => r.folderId === folderId).sort((a, b) => a.key - b.key);
  }

  // ── Mutations used by tests ──────────────────────────────────────
  move(key, accountId, path) {
    this.msgs.get(key).folderId = this.folderId(accountId, path);
  }
  remove(key) {
    this.msgs.delete(key);
    const id = this.idByKey.get(key);
    if (id !== undefined) this.keyById.delete(id);
  }
  update(key, props) {
    Object.assign(this.msgs.get(key).meta, props);
  }
  findByMid(mid) {
    return [...this.msgs.values()].filter((r) => r.meta.headerMessageId === mid);
  }

  // ── The messenger API ────────────────────────────────────────────
  get messenger() {
    const tb = this;
    const accountObj = (a, withFolders) => {
      const root = { id: `${a.id}:/`, accountId: a.id, name: "Root", path: "/", isRoot: true };
      if (withFolders) root.subFolders = tb.childFolders(a.id, "/").map((f) => tb.folderObj(f, true));
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        identities: a.identities || (a.email ? [{ id: `id-${a.id}`, email: a.email, name: "Anna Schmidt" }] : []),
        rootFolder: root,
        folders: withFolders ? root.subFolders : undefined,
      };
    };
    const resolveFolder = (f) => (typeof f === "string" ? tb.folders.get(f) : f?.id ? tb.folders.get(f.id) : undefined);
    return {
      runtime: { getManifest: () => ({ version: "2.1.0" }) },
      idle: { onStateChanged: { addListener() {} } },
      accounts: {
        list: async (withFolders = true) => [...tb.accounts.values()].map((a) => accountObj(a, withFolders)),
        get: async (id, withFolders = true) => {
          const a = tb.accounts.get(id);
          return a ? accountObj(a, withFolders) : null;
        },
      },
      folders: {
        get: async (folderId, withSub = false) => {
          if (typeof folderId === "string" && folderId.endsWith(":/")) {
            const a = tb.accounts.get(folderId.slice(0, -2));
            if (a) return accountObj(a, true).rootFolder;
          }
          const f = tb.folders.get(folderId);
          if (!f) throw new Error(`Folder not found: ${folderId}`);
          return tb.folderObj(f, withSub);
        },
        getFolderInfo: async (folder) => {
          if (folder?.isRoot) return { totalMessageCount: 0, unreadMessageCount: 0, newMessageCount: 0 };
          const f = resolveFolder(folder);
          if (!f) throw new Error("Folder not found");
          const msgs = tb.folderMessages(f.id);
          return { totalMessageCount: msgs.length, unreadMessageCount: msgs.filter((m) => !m.meta.read).length, newMessageCount: 0 };
        },
        getSubFolders: async (folder) => {
          const f = resolveFolder(folder);
          return f ? tb.childFolders(f.accountId, f.path).map((c) => tb.folderObj(c, true)) : [];
        },
      },
      messages: {
        list: async (folder) => {
          tb.calls.list++;
          const f = resolveFolder(folder);
          if (!f) throw new Error("Folder not found");
          return tb.paginate(tb.folderMessages(f.id));
        },
        continueList: async (pageId) => {
          const p = tb.pages.get(pageId);
          if (!p) throw new Error(`Invalid list id ${pageId}`);
          const first = p.rest.slice(0, PAGE);
          p.rest = p.rest.slice(PAGE);
          if (!p.rest.length) {
            tb.pages.delete(pageId);
            return { id: null, messages: first };
          }
          return { id: pageId, messages: first };
        },
        query: async (q = {}) => {
          tb.calls.query++;
          const lc = (s) => String(s || "").toLowerCase();
          let recs = [...tb.msgs.values()].sort((a, b) => a.key - b.key);
          recs = recs.filter((r) => {
            const m = r.meta;
            const f = tb.folders.get(r.folderId);
            if (q.folderId && r.folderId !== q.folderId) return false;
            if (q.accountId && f.accountId !== q.accountId) return false;
            if (q.headerMessageId && m.headerMessageId !== q.headerMessageId) return false;
            if (q.subject && !lc(m.subject).includes(lc(q.subject))) return false;
            if (q.author && !lc(m.author).includes(lc(q.author))) return false;
            if (q.recipients && !lc(m.recipients.join(",")).includes(lc(q.recipients))) return false;
            if (q.body && !r.text.includes(lc(q.body))) return false;
            if (q.fullText && !(r.text.includes(lc(q.fullText)) || lc(m.author).includes(lc(q.fullText)))) return false;
            if (q.unread && m.read) return false;
            if (q.flagged !== undefined && m.flagged !== q.flagged) return false;
            if (q.junk !== undefined && m.junk !== q.junk) return false;
            if (q.fromDate && m.date < new Date(q.fromDate).getTime()) return false;
            if (q.toDate && m.date > new Date(q.toDate).getTime()) return false;
            if (q.attachment && !r.attachments.length) return false;
            return true;
          });
          return tb.paginate(recs);
        },
        get: async (id) => tb.header(tb.recById(id)),
        getFull: async (id) => {
          tb.calls.getFull++;
          const rec = tb.recById(id);
          const bodyNode =
            rec.bodyParts.length > 1
              ? { contentType: "multipart/alternative", partName: "1.1", parts: rec.bodyParts.map((p, i) => ({ ...p, partName: `1.1.${i + 1}` })) }
              : { ...rec.bodyParts[0], partName: "1.1" };
          return {
            contentType: "message/rfc822",
            partName: "",
            headers: { "message-id": [`<${rec.meta.headerMessageId}>`], subject: [rec.meta.subject] },
            parts: [
              {
                contentType: "multipart/mixed",
                partName: "1",
                parts: [bodyNode, ...rec.attachments.map((a) => ({ contentType: a.contentType, name: a.name, partName: a.partName, size: a.size }))],
              },
            ],
          };
        },
        getRaw: async (id) => {
          tb.calls.getRaw++;
          return tb.recById(id).raw.toString("latin1");
        },
        getAttachmentFile: async (id, partName) => {
          const a = tb.recById(id).attachments.find((x) => x.partName === partName);
          if (!a) throw new Error("Attachment not found");
          return { name: a.name, size: a.size, type: a.contentType, arrayBuffer: async () => a.content.buffer.slice(a.content.byteOffset, a.content.byteOffset + a.content.length) };
        },
        listTags: async () => [{ key: "$label1", tag: "Important", color: "#FF0000" }],
      },
      addressBooks: { list: async () => [] },
      contacts: { list: async () => [] },
    };
  }
}
