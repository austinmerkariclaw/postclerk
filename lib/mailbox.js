'use strict';

const { ImapClient, imapDate } = require('./imap/client');
const { normalize } = require('./message');
const store = require('./store');

/**
 * The Mailbox facade.
 *
 * Everything above this line works on normalized `Message` objects and knows
 * nothing about IMAP (design §2). That boundary is what lets triage be tested
 * without a server, and what will let a second transport drop in later without
 * touching a line of triage logic.
 */

class Mailbox {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.folders = null;
  }

  static async open(config, password, opts = {}) {
    const client = new ImapClient({
      host: config.imap.host,
      port: config.imap.port,
      tls: opts.tls !== false,
      createConnection: opts.createConnection,
    });

    await client.connect();
    await client.login(config.imap.user, password);

    const mailbox = new Mailbox(client, config);
    await mailbox.resolveFolders();
    return mailbox;
  }

  /** Merge configured folder names with what the server actually advertises. */
  async resolveFolders() {
    const detected = await this.client.specialFolders();
    const configured = this.config.folders || {};

    this.folders = {
      inbox: configured.inbox || 'INBOX',
      sent: configured.sent || detected.sent,
      drafts: configured.drafts || detected.drafts,
      later: configured.later || 'postclerk/Later',
      brief: configured.brief || 'postclerk/Brief',
      noise: configured.noise || 'postclerk/Noise',
      available: detected.all.map((f) => f.name),
    };
    return this.folders;
  }

  /**
   * Fetch messages from a folder since N days ago.
   * Headers only by default — that is all triage needs, and it keeps a
   * thousand-message sync to a few seconds.
   */
  async fetchSince(folder, days, { withBody = false, limit = 2000 } = {}) {
    const box = await this.client.select(folder, { readOnly: true });

    // A changed UIDVALIDITY means every cached UID now points somewhere else.
    if (box.uidValidity != null) {
      const check = store.checkUidValidity(folder, box.uidValidity);
      if (check.changed) store.clearMessageCache();
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let uids = await this.client.search(`SINCE ${imapDate(since)}`);
    if (uids.length > limit) uids = uids.slice(-limit); // newest wins

    const items = withBody
      ? '(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])'
      : '(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])';

    const fetched = await this.client.fetch(uids, items);

    return fetched
      .filter((row) => row.uid !== null)
      .map((row) => normalize(row.raw, {
        uid: row.uid,
        folder,
        flags: row.flags,
        size: row.size,
        internalDate: row.internalDate,
      }));
  }

  async fetchInbox(days, opts) {
    return this.fetchSince(this.folders.inbox, days, opts);
  }

  async fetchSent(days, opts) {
    if (!this.folders.sent) return [];
    return this.fetchSince(this.folders.sent, days, opts);
  }

  /** Fetch full bodies for specific UIDs — used only for escalation and drafting. */
  async fetchBodies(folder, uids) {
    if (!uids.length) return [];
    await this.client.select(folder, { readOnly: true });
    const fetched = await this.client.fetch(uids, '(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])');
    return fetched
      .filter((row) => row.uid !== null)
      .map((row) => normalize(row.raw, {
        uid: row.uid,
        folder,
        flags: row.flags,
        size: row.size,
        internalDate: row.internalDate,
      }));
  }

  /** Create the destination folders if they are missing. */
  async ensureFolders() {
    const created = [];
    const existing = new Set(this.folders.available);
    for (const key of ['later', 'brief', 'noise']) {
      const name = this.folders[key];
      if (!name || existing.has(name)) continue;
      const result = await this.client.createFolder(name);
      if (result.created) created.push(name);
    }
    if (created.length) await this.resolveFolders();
    return created;
  }

  /**
   * Apply one action. Only three verbs exist, and none of them destroys mail:
   * copy to a folder, set a flag, clear a flag.
   */
  async applyAction(action) {
    if (action.action === 'move') {
      await this.client.select(action.from, { readOnly: false });
      await this.client.copyMessage([action.uid], action.to);
      // Deliberately a copy, not a move: the original stays in place, so the
      // worst case of a wrong decision is a duplicate, never a lost message.
      return;
    }
    if (action.action === 'flag') {
      await this.client.select(action.from || this.folders.inbox, { readOnly: false });
      await this.client.storeFlags([action.uid], action.flags);
      return;
    }
    if (action.action === 'unflag') {
      await this.client.select(action.from || this.folders.inbox, { readOnly: false });
      await this.client.storeFlags([action.uid], action.flags, { remove: true });
      return;
    }
    if (action.action === 'draft') {
      await this.client.append(this.folders.drafts || 'Drafts', action.raw, ['\\Draft']);
      return;
    }
    throw new Error(`unknown action "${action.action}"`);
  }

  async appendDraft(raw) {
    const folder = this.folders.drafts;
    if (!folder) throw new Error('no Drafts folder found — set folders.drafts in config');
    await this.client.append(folder, raw, ['\\Draft']);
    return folder;
  }

  async close() {
    await this.client.logout();
  }
}

module.exports = { Mailbox };
