'use strict';

const net = require('node:net');

/**
 * An in-process IMAP server good enough to exercise the real client.
 *
 * This exists because the alternative is untestable code. postclerk cannot be
 * tested against a live mailbox — there is no account, and a test suite that
 * needs credentials is a test suite nobody runs. So the protocol layer is
 * verified against a server that speaks the same wire format, including the
 * parts that are easy to get wrong: literals, UID sets, and APPEND's
 * continuation handshake.
 *
 * It is intentionally a little rude — it emits literals where a lazier server
 * would send quoted strings — because the client must handle the harder form.
 */
class MockImapServer {
  constructor({ messages = [], mailboxes = null, folders = null, user = 'user', password = 'pass' } = {}) {
    const prepare = (list) => list.map((m, i) => ({
      uid: m.uid ?? i + 1,
      flags: m.flags ? [...m.flags] : [],
      internalDate: m.internalDate || new Date('2026-08-15T10:00:00Z'),
      raw: m.raw || '',
    }));

    /** Per-folder message stores. INBOX is the default when none is given. */
    this.mailboxes = new Map();
    if (mailboxes) {
      for (const [name, list] of Object.entries(mailboxes)) {
        this.mailboxes.set(name, prepare(list));
      }
    }
    if (!this.mailboxes.has('INBOX')) this.mailboxes.set('INBOX', prepare(messages));
    this.folders = folders || [
      { name: 'INBOX', flags: [] },
      { name: 'Sent', flags: ['\\Sent'] },
      { name: 'Drafts', flags: ['\\Drafts'] },
      { name: 'Archive', flags: ['\\Archive'] },
    ];
    this.user = user;
    this.password = password;

    /** Everything the client did, so tests can assert on behavior. */
    this.commandLog = [];
    this.appended = [];
    this.copied = [];
    this.storedFlags = [];

    this.server = net.createServer((socket) => this._handle(socket));
    this.port = null;
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  /** A `createConnection` function to hand to ImapClient for tests. */
  connector() {
    return () => net.connect({ host: '127.0.0.1', port: this.port });
  }

  /** Messages in the folder this connection currently has selected. */
  get messages() {
    return this.mailboxes.get(this._selected || 'INBOX') || [];
  }

  _handle(socket) {
    let buffer = Buffer.alloc(0);
    let awaitingLiteral = null; // { size, tag, mailbox, flags }
    this._selected = 'INBOX';

    socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] mock ready\r\n');

    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (awaitingLiteral) {
          if (buffer.length < awaitingLiteral.size) return;
          const body = buffer.subarray(0, awaitingLiteral.size).toString('utf8');
          buffer = buffer.subarray(awaitingLiteral.size);
          // Swallow the CRLF that follows the literal.
          if (buffer[0] === 0x0d && buffer[1] === 0x0a) buffer = buffer.subarray(2);

          this.appended.push({ mailbox: awaitingLiteral.mailbox, body, flags: awaitingLiteral.flags });
          socket.write(`${awaitingLiteral.tag} OK APPEND completed\r\n`);
          awaitingLiteral = null;
          continue;
        }

        const idx = buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = buffer.subarray(0, idx).toString('utf8');
        buffer = buffer.subarray(idx + 2);
        const next = this._command(socket, line);
        if (next) awaitingLiteral = next;
      }
    });
  }

  _command(socket, line) {
    this.commandLog.push(line);
    const space = line.indexOf(' ');
    const tag = line.slice(0, space);
    const rest = line.slice(space + 1);
    const verb = rest.split(' ')[0].toUpperCase();
    const args = rest.slice(verb.length).trim();

    // These return null, not the result of socket.write() — write() returns a
    // boolean, and a truthy return here is interpreted as "awaiting a literal".
    const ok = (text = 'completed') => { socket.write(`${tag} OK ${text}\r\n`); return null; };
    const no = (text) => { socket.write(`${tag} NO ${text}\r\n`); return null; };

    switch (verb) {
      case 'CAPABILITY':
        socket.write('* CAPABILITY IMAP4rev1 UIDPLUS SPECIAL-USE\r\n');
        return ok('CAPABILITY completed');

      case 'LOGIN': {
        const m = args.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/);
        if (!m) return no('LOGIN syntax');
        const user = m[1].replace(/\\(.)/g, '$1');
        const pass = m[2].replace(/\\(.)/g, '$1');
        if (user !== this.user || pass !== this.password) return no('AUTHENTICATIONFAILED');
        return ok('LOGIN completed');
      }

      case 'LIST': {
        for (const f of this.folders) {
          const flags = ['\\HasNoChildren', ...f.flags].join(' ');
          socket.write(`* LIST (${flags}) "/" "${f.name}"\r\n`);
        }
        return ok('LIST completed');
      }

      case 'SELECT':
      case 'EXAMINE': {
        const name = (args.match(/^"(.*)"$/) || [])[1] || args.trim();
        if (!this.mailboxes.has(name)) this.mailboxes.set(name, []);
        this._selected = name;
        socket.write(`* ${this.messages.length} EXISTS\r\n`);
        socket.write('* 0 RECENT\r\n');
        socket.write('* OK [UIDVALIDITY 90210] UIDs valid\r\n');
        return ok(`[READ-WRITE] ${verb} completed`);
      }

      case 'NOOP':
        return ok('NOOP completed');

      case 'CREATE': {
        const name = (args.match(/^"(.*)"$/) || [])[1];
        if (!name) return no('CREATE syntax');
        if (this.folders.some((f) => f.name === name)) return no('[ALREADYEXISTS] mailbox exists');
        this.folders.push({ name, flags: [] });
        return ok('CREATE completed');
      }

      case 'UID': {
        const sub = args.split(' ')[0].toUpperCase();
        const subArgs = args.slice(sub.length).trim();

        if (sub === 'SEARCH') {
          const uids = this._search(subArgs);
          socket.write(`* SEARCH ${uids.join(' ')}\r\n`);
          return ok('UID SEARCH completed');
        }

        if (sub === 'FETCH') {
          const setEnd = subArgs.indexOf(' ');
          const set = subArgs.slice(0, setEnd);
          const items = subArgs.slice(setEnd + 1);
          const wanted = expandUidSet(set);
          let seq = 0;
          for (const msg of this.messages) {
            seq++;
            if (!wanted.has(msg.uid)) continue;
            socket.write(this._fetchResponse(seq, msg, items));
          }
          return ok('UID FETCH completed');
        }

        if (sub === 'STORE') {
          const m = subArgs.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\((.*)\)$/i);
          if (!m) return no('STORE syntax');
          const wanted = expandUidSet(m[1]);
          const removing = m[2].startsWith('-');
          const flags = m[3].split(/\s+/).filter(Boolean);
          for (const msg of this.messages) {
            if (!wanted.has(msg.uid)) continue;
            for (const flag of flags) {
              if (removing) msg.flags = msg.flags.filter((f) => f !== flag);
              else if (!msg.flags.includes(flag)) msg.flags.push(flag);
            }
          }
          this.storedFlags.push({ set: m[1], flags, removing });
          return ok('UID STORE completed');
        }

        if (sub === 'COPY') {
          const m = subArgs.match(/^(\S+)\s+"(.*)"$/);
          if (!m) return no('COPY syntax');
          this.copied.push({ uids: [...expandUidSet(m[1])], destination: m[2] });
          return ok('UID COPY completed');
        }

        return no(`unsupported UID ${sub}`);
      }

      case 'APPEND': {
        const m = args.match(/^"([^"]+)"(?:\s+\(([^)]*)\))?\s+\{(\d+)\+?\}$/);
        if (!m) return no('APPEND syntax');
        socket.write('+ ready for literal\r\n');
        return {
          size: Number(m[3]),
          tag,
          mailbox: m[1],
          flags: m[2] ? m[2].split(/\s+/).filter(Boolean) : [],
        };
      }

      case 'LOGOUT':
        socket.write('* BYE mock signing off\r\n');
        ok('LOGOUT completed');
        socket.end();
        return null;

      default:
        return no(`unrecognized command ${verb}`);
    }
  }

  _search(criteria) {
    const upper = criteria.toUpperCase();
    let result = this.messages;

    const since = /SINCE (\d{2}-[A-Za-z]{3}-\d{4})/.exec(criteria);
    if (since) {
      const cutoff = new Date(since[1].replace(/-/g, ' '));
      result = result.filter((m) => m.internalDate >= cutoff);
    }
    if (upper.includes('UNSEEN')) result = result.filter((m) => !m.flags.includes('\\Seen'));
    if (upper.includes('SEEN')) result = result.filter((m) => m.flags.includes('\\Seen'));

    return result.map((m) => m.uid);
  }

  _fetchResponse(seq, msg, items) {
    const parts = [`UID ${msg.uid}`];
    const wantsHeaderOnly = /BODY(?:\.PEEK)?\[HEADER\]/i.test(items);
    const wantsFull = /BODY(?:\.PEEK)?\[\]/i.test(items);

    if (/FLAGS/i.test(items)) parts.push(`FLAGS (${msg.flags.join(' ')})`);
    if (/INTERNALDATE/i.test(items)) {
      parts.push(`INTERNALDATE "${formatInternalDate(msg.internalDate)}"`);
    }
    if (/RFC822\.SIZE/i.test(items)) parts.push(`RFC822.SIZE ${Buffer.byteLength(msg.raw)}`);

    let payload = null;
    let label = null;
    if (wantsFull) {
      payload = msg.raw;
      label = 'BODY[]';
    } else if (wantsHeaderOnly) {
      const split = msg.raw.search(/\r?\n\r?\n/);
      payload = split === -1 ? msg.raw : msg.raw.slice(0, split + 2);
      label = 'BODY[HEADER]';
    }

    if (payload === null) return `* ${seq} FETCH (${parts.join(' ')})\r\n`;

    // Emit the payload as a literal — the form the client must handle.
    const normalized = payload.replace(/\r?\n/g, '\r\n');
    const bytes = Buffer.byteLength(normalized, 'utf8');
    return `* ${seq} FETCH (${parts.join(' ')} ${label} {${bytes}}\r\n${normalized})\r\n`;
  }
}

function expandUidSet(set) {
  const out = new Set();
  for (const part of String(set).split(',')) {
    const range = part.split(':');
    if (range.length === 2) {
      const lo = Number(range[0]);
      const hi = range[1] === '*' ? lo : Number(range[1]);
      for (let i = lo; i <= hi; i++) out.add(i);
    } else {
      const n = Number(part);
      if (Number.isInteger(n)) out.add(n);
    }
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatInternalDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

module.exports = { MockImapServer, expandUidSet };
