'use strict';

const tls = require('node:tls');
const net = require('node:net');
const {
  readResponse,
  classify,
  fetchItemsToObject,
  quote,
  ProtocolError,
} = require('./parser');

/**
 * A minimal IMAP client covering exactly the command subset postclerk needs.
 *
 * NOTE FOR REVIEWERS AND FOR ANYONE EXTENDING THIS FILE:
 * There is deliberately no way to delete mail here. No `\Deleted` flag, no
 * EXPUNGE, no DELETE. That is a product guarantee (ADR-005), not an oversight,
 * and `test/safety.test.js` fails the build if those tokens appear in the
 * source. Move mail with `copyMessage`; let the user delete it themselves.
 */

const DEFAULTS = {
  port: 993,
  tls: true,
  connectTimeoutMs: 30_000,
  commandTimeoutMs: 120_000,
};

class ImapError extends Error {
  constructor(message, { status, command } = {}) {
    super(message);
    this.name = 'ImapError';
    this.status = status;
    this.command = command;
  }
}

class ImapClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {boolean} [opts.tls] false only for tests against a local server
   * @param {function} [opts.createConnection] injection point for tests
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.tagCounter = 0;
    this.pending = null;       // the in-flight command
    this.queue = [];           // commands waiting their turn
    this.capabilities = new Set();
    this.selected = null;      // { name, uidValidity, exists }
    this.greeted = false;
    this._greetResolve = null;
    this._greetReject = null;
    this.closed = false;
  }

  // ---------------------------------------------------------------- transport

  async connect() {
    const { host, port, createConnection } = this.opts;

    const greeting = new Promise((resolve, reject) => {
      this._greetResolve = resolve;
      this._greetReject = reject;
    });

    this.socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ImapError(`connection to ${host}:${port} timed out`));
      }, this.opts.connectTimeoutMs);

      const onReady = (sock) => { clearTimeout(timer); resolve(sock); };
      const onFail = (err) => { clearTimeout(timer); reject(err); };

      if (createConnection) {
        // Test transport: a plain socket to an in-process server.
        const sock = createConnection();
        sock.once('error', onFail);
        if (sock.connecting) sock.once('connect', () => onReady(sock));
        else onReady(sock);
        return;
      }

      if (this.opts.tls) {
        // Certificate verification stays on. A mail client that disables it is
        // a credential-harvesting accident waiting for a coffee shop.
        const sock = tls.connect({ host, port, servername: host }, () => onReady(sock));
        sock.once('error', onFail);
      } else {
        const sock = net.connect({ host, port }, () => onReady(sock));
        sock.once('error', onFail);
      }
    });

    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (err) => this._fail(err));
    this.socket.on('close', () => this._fail(new ImapError('connection closed by server')));

    await greeting;
    return this;
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    if (this._greetReject) { this._greetReject(err); this._greetReject = null; }
    if (this.pending) { this.pending.reject(err); this.pending = null; }
    for (const cmd of this.queue.splice(0)) cmd.reject(err);
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    for (;;) {
      let framed;
      try {
        framed = readResponse(this.buffer);
      } catch (err) {
        this._fail(err instanceof ProtocolError ? err : new ImapError(String(err)));
        return;
      }
      if (!framed) return;
      this.buffer = framed.rest;

      let parsed;
      try {
        parsed = classify(framed.response);
      } catch {
        continue; // unparseable line; skip rather than kill the session
      }
      this._dispatch(parsed);
    }
  }

  _dispatch(parsed) {
    if (!this.greeted) {
      // First line is the server greeting: `* OK ...` or `* PREAUTH` / `* BYE`.
      this.greeted = true;
      const text = (parsed.raw || Buffer.alloc(0)).toString('utf8');
      if (/^\*\s+(OK|PREAUTH)/i.test(text)) {
        if (parsed.kind === 'untagged') this._absorbCapability(parsed.tokens);
        this._greetResolve(this);
      } else {
        this._greetReject(new ImapError(`server refused connection: ${text.trim()}`));
      }
      this._greetResolve = null;
      this._greetReject = null;
      return;
    }

    if (parsed.kind === 'continuation') {
      if (this.pending && this.pending.onContinuation) this.pending.onContinuation(parsed);
      return;
    }

    if (parsed.kind === 'untagged') {
      this._absorbCapability(parsed.tokens);
      if (this.pending) this.pending.untagged.push(parsed.tokens);
      return;
    }

    if (parsed.kind === 'tagged' && this.pending && parsed.tag === this.pending.tag) {
      const cmd = this.pending;
      this.pending = null;
      clearTimeout(cmd.timer);

      if (parsed.status === 'OK') {
        cmd.resolve({ status: 'OK', text: parsed.text, untagged: cmd.untagged });
      } else {
        cmd.reject(new ImapError(
          `${cmd.label} failed: ${parsed.status} ${parsed.text}`,
          { status: parsed.status, command: cmd.label }
        ));
      }
      this._drain();
    }
  }

  _absorbCapability(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return;
    if (String(tokens[0]).toUpperCase() !== 'CAPABILITY') return;
    for (const cap of tokens.slice(1)) {
      if (typeof cap === 'string') this.capabilities.add(cap.toUpperCase());
    }
  }

  _drain() {
    if (this.pending || this.queue.length === 0) return;
    const cmd = this.queue.shift();
    this.pending = cmd;
    cmd.timer = setTimeout(() => {
      this.pending = null;
      cmd.reject(new ImapError(`${cmd.label} timed out`));
      this._drain();
    }, this.opts.commandTimeoutMs);
    this.socket.write(`${cmd.tag} ${cmd.text}\r\n`);
  }

  /**
   * Run one command and resolve when its tagged response arrives.
   * Commands are serialized: IMAP permits pipelining, but the complexity is
   * not worth it for a tool that runs a handful of commands per invocation.
   */
  _exec(text, { label = text.split(' ')[0], onContinuation = null } = {}) {
    if (this.closed) return Promise.reject(new ImapError('connection is closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({
        tag: `p${++this.tagCounter}`,
        text,
        label,
        untagged: [],
        onContinuation,
        resolve,
        reject,
        timer: null,
      });
      this._drain();
    });
  }

  // ----------------------------------------------------------------- commands

  async capability() {
    const res = await this._exec('CAPABILITY');
    return [...this.capabilities];
  }

  async login(user, password) {
    if (this.capabilities.has('LOGINDISABLED')) {
      throw new ImapError('server advertises LOGINDISABLED — plain login is not permitted');
    }
    // Credentials are quoted, never logged, and never stored on the instance.
    await this._exec(`LOGIN ${quote(user)} ${quote(password)}`, { label: 'LOGIN' });
    await this.capability();
    return this;
  }

  /** List mailboxes, returning name + flags (special-use where advertised). */
  async list() {
    const res = await this._exec('LIST "" "*"');
    const out = [];
    for (const tokens of res.untagged) {
      if (!Array.isArray(tokens) || String(tokens[0]).toUpperCase() !== 'LIST') continue;
      const flags = Array.isArray(tokens[1]) ? tokens[1].map(String) : [];
      const delimiter = tokens[2] == null ? '/' : String(tokens[2]);
      const name = tokens[3] == null ? '' : String(tokens[3]);
      if (name) out.push({ name, flags, delimiter });
    }
    return out;
  }

  /**
   * Resolve well-known folders. Prefer RFC 6154 SPECIAL-USE flags; fall back to
   * name matching, which is what most servers without SPECIAL-USE need.
   */
  async specialFolders() {
    const boxes = await this.list();
    const byFlag = (flag) => boxes.find((b) => b.flags.some((f) => f.toLowerCase() === flag));
    const byName = (re) => boxes.find((b) => re.test(b.name));

    return {
      inbox: 'INBOX',
      sent: (byFlag('\\sent') || byName(/^(\[Gmail\][/.])?sent(\s|$|[ _-]?(mail|items))/i))?.name || null,
      drafts: (byFlag('\\drafts') || byName(/^(\[Gmail\][/.])?drafts?$/i))?.name || null,
      archive: (byFlag('\\archive') || byName(/^(\[Gmail\][/.])?(archive|all mail)$/i))?.name || null,
      junk: (byFlag('\\junk') || byName(/^(\[Gmail\][/.])?(junk|spam)$/i))?.name || null,
      all: boxes,
    };
  }

  /** SELECT a mailbox for read-write, or EXAMINE for read-only. */
  async select(mailbox, { readOnly = false } = {}) {
    const verb = readOnly ? 'EXAMINE' : 'SELECT';
    const res = await this._exec(`${verb} ${quote(mailbox)}`, { label: verb });

    let uidValidity = null;
    let exists = 0;
    for (const tokens of res.untagged) {
      if (!Array.isArray(tokens)) continue;
      const second = String(tokens[1] || '').toUpperCase();
      if (second === 'EXISTS') exists = Number(tokens[0]) || 0;
    }
    // UIDVALIDITY arrives in the tagged/untagged OK response code: [UIDVALIDITY 123]
    const codeMatch = /\[UIDVALIDITY (\d+)\]/i.exec(res.text || '');
    if (codeMatch) uidValidity = Number(codeMatch[1]);
    if (uidValidity === null) {
      for (const tokens of res.untagged) {
        const flat = Array.isArray(tokens) ? tokens.join(' ') : '';
        const m = /UIDVALIDITY[\s[]*(\d+)/i.exec(flat);
        if (m) { uidValidity = Number(m[1]); break; }
      }
    }

    this.selected = { name: mailbox, uidValidity, exists, readOnly };
    return this.selected;
  }

  /** UID SEARCH. `criteria` is raw IMAP search syntax, e.g. 'SINCE 1-Aug-2026'. */
  async search(criteria) {
    const res = await this._exec(`UID SEARCH ${criteria}`, { label: 'UID SEARCH' });
    const uids = [];
    for (const tokens of res.untagged) {
      if (!Array.isArray(tokens)) continue;
      if (String(tokens[0]).toUpperCase() !== 'SEARCH') continue;
      for (const t of tokens.slice(1)) {
        const n = Number(t);
        if (Number.isInteger(n) && n > 0) uids.push(n);
      }
    }
    return uids;
  }

  /**
   * UID FETCH. Returns [{ uid, flags, internalDate, headers, body, size }].
   * `items` is the raw fetch item spec, e.g.
   *   '(UID FLAGS INTERNALDATE BODY.PEEK[HEADER])'
   *
   * BODY.PEEK is used rather than BODY so that reading mail does not mark it
   * \Seen. Silently marking a user's unread mail as read while "just looking"
   * would be its own small betrayal.
   */
  async fetch(uids, items = '(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])') {
    if (!uids || uids.length === 0) return [];
    const set = compressUidSet(uids);
    const res = await this._exec(`UID FETCH ${set} ${items}`, { label: 'UID FETCH' });

    const out = [];
    for (const tokens of res.untagged) {
      if (!Array.isArray(tokens)) continue;
      if (String(tokens[1] || '').toUpperCase() !== 'FETCH') continue;
      const fields = fetchItemsToObject(tokens[2]);

      const bodyKey = Object.keys(fields).find((k) => k.startsWith('body['));
      out.push({
        seq: Number(tokens[0]) || null,
        uid: Number(fields.uid) || null,
        flags: Array.isArray(fields.flags) ? fields.flags.map(String) : [],
        internalDate: fields.internaldate ? new Date(String(fields.internaldate)) : null,
        size: Number(fields['rfc822.size']) || 0,
        raw: bodyKey ? String(fields[bodyKey] || '') : '',
      });
    }
    return out;
  }

  /** Add or remove flags. Rejects `\Deleted` outright — see the file header. */
  async storeFlags(uids, flags, { remove = false } = {}) {
    if (!uids || uids.length === 0) return;
    for (const flag of flags) {
      if (/^\\deleted$/i.test(String(flag))) {
        throw new ImapError('refusing to set \\Deleted — postclerk never deletes mail');
      }
    }
    const verb = remove ? '-FLAGS.SILENT' : '+FLAGS.SILENT';
    const set = compressUidSet(uids);
    await this._exec(`UID STORE ${set} ${verb} (${flags.join(' ')})`, { label: 'UID STORE' });
  }

  /**
   * Copy messages to another mailbox. This is how postclerk "files" mail:
   * a copy leaves the original untouched, so the operation is trivially
   * reversible and cannot lose anything.
   */
  async copyMessage(uids, destination) {
    if (!uids || uids.length === 0) return;
    const set = compressUidSet(uids);
    await this._exec(`UID COPY ${set} ${quote(destination)}`, { label: 'UID COPY' });
  }

  /** APPEND a message (used to stage reply drafts in the Drafts folder). */
  async append(mailbox, rawMessage, flags = ['\\Draft']) {
    const payload = Buffer.from(String(rawMessage).replace(/\r?\n/g, '\r\n'), 'utf8');
    const flagPart = flags.length ? ` (${flags.join(' ')})` : '';
    const command = `APPEND ${quote(mailbox)}${flagPart} {${payload.length}}`;

    return this._exec(command, {
      label: 'APPEND',
      onContinuation: () => {
        this.socket.write(payload);
        this.socket.write('\r\n');
      },
    });
  }

  /**
   * Create a mailbox, tolerating "already exists".
   * CREATE is additive — it is the one mailbox-structure command that cannot
   * lose anything, which is why it is the only one implemented here.
   */
  async createFolder(name) {
    try {
      await this._exec(`CREATE ${quote(name)}`, { label: 'CREATE' });
      return { created: true };
    } catch (err) {
      if (err instanceof ImapError && err.status === 'NO') return { created: false };
      throw err;
    }
  }

  async noop() {
    await this._exec('NOOP');
  }

  async logout() {
    if (this.closed) return;
    try {
      await this._exec('LOGOUT');
    } catch {
      // A server that hangs up during LOGOUT is behaving normally enough.
    } finally {
      this.close();
    }
  }

  close() {
    this.closed = true;
    if (this.socket) {
      this.socket.removeAllListeners('close');
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

/**
 * Compress a UID list into IMAP set syntax: [1,2,3,7,9,10] → "1:3,7,9:10".
 * Sending ten thousand comma-separated UIDs works but produces absurd command
 * lines; ranges keep them sane.
 */
function compressUidSet(uids) {
  const sorted = [...new Set(uids.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  if (sorted.length === 0) return '';

  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) { prev = cur; continue; }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(',');
}

/** Format a Date as IMAP's search date format: 01-Aug-2026. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function imapDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

module.exports = { ImapClient, ImapError, compressUidSet, imapDate };
