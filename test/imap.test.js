'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ImapClient, ImapError, compressUidSet, imapDate } = require('../lib/imap/client');
const parser = require('../lib/imap/parser');
const { MockImapServer } = require('./helpers/mock-imap-server');
const fx = require('./helpers/fixtures');

async function withServer(run, opts = {}) {
  const server = new MockImapServer({ messages: fx.asServerMessages(), ...opts });
  await server.listen();
  const client = new ImapClient({ createConnection: server.connector(), tls: false });
  try {
    await client.connect();
    return await run(client, server);
  } finally {
    client.close();
    await server.close();
  }
}

// --------------------------------------------------------------- parser units

test('readResponse returns null until a full line has arrived', () => {
  assert.strictEqual(parser.readResponse(Buffer.from('* OK partial')), null);
  const framed = parser.readResponse(Buffer.from('* OK done\r\nnext'));
  assert.strictEqual(framed.response.toString(), '* OK done');
  assert.strictEqual(framed.rest.toString(), 'next');
});

test('readResponse consumes literals rather than stopping at their CRLF', () => {
  // The literal body contains a CRLF. A line-based reader truncates here.
  const wire = Buffer.from('* 1 FETCH (BODY[HEADER] {12}\r\nA: 1\r\nB: 2\r\n)\r\ntail');
  const framed = parser.readResponse(wire);
  assert.ok(framed, 'expected a complete response');
  assert.strictEqual(framed.rest.toString(), 'tail');
  assert.ok(framed.response.toString().includes('B: 2'));
});

test('readResponse waits when a literal is only partially received', () => {
  assert.strictEqual(parser.readResponse(Buffer.from('* 1 FETCH (X {20}\r\nshort')), null);
});

test('parseTokens handles nested lists, quoted strings and NIL', () => {
  const tokens = parser.parseTokens(Buffer.from('LIST (\\HasNoChildren \\Sent) "/" "Sent Mail" NIL'));
  assert.strictEqual(tokens[0], 'LIST');
  assert.deepStrictEqual(tokens[1], ['\\HasNoChildren', '\\Sent']);
  assert.strictEqual(tokens[2], '/');
  assert.strictEqual(tokens[3], 'Sent Mail');
  assert.strictEqual(tokens[4], null);
});

test('parseTokens keeps BODY[...] as one atom despite inner spaces', () => {
  const tokens = parser.parseTokens(Buffer.from('(BODY[HEADER.FIELDS (FROM TO)] "x")'));
  assert.deepStrictEqual(tokens[0][0], 'BODY[HEADER.FIELDS (FROM TO)]');
  assert.strictEqual(tokens[0][1], 'x');
});

test('parseTokens unescapes quoted strings', () => {
  const tokens = parser.parseTokens(Buffer.from('"a \\"quoted\\" \\\\ value"'));
  assert.strictEqual(tokens[0], 'a "quoted" \\ value');
});

test('compressUidSet collapses runs into ranges', () => {
  assert.strictEqual(compressUidSet([1, 2, 3, 7, 9, 10]), '1:3,7,9:10');
  assert.strictEqual(compressUidSet([5]), '5');
  assert.strictEqual(compressUidSet([]), '');
  assert.strictEqual(compressUidSet([3, 1, 2]), '1:3');
});

test('imapDate formats the way IMAP SEARCH expects', () => {
  assert.strictEqual(imapDate(new Date('2026-08-01T00:00:00Z')), '01-Aug-2026');
});

// ------------------------------------------------------------ client + server

test('connects, logs in, and reads capabilities', async () => {
  await withServer(async (client) => {
    await client.login('user', 'pass');
    assert.ok(client.capabilities.has('IMAP4REV1'));
    assert.ok(client.capabilities.has('SPECIAL-USE'));
  });
});

test('rejects a wrong password with a useful error', async () => {
  await withServer(async (client) => {
    await assert.rejects(
      () => client.login('user', 'wrong'),
      (err) => err instanceof ImapError && /AUTHENTICATIONFAILED/.test(err.message)
    );
  });
});

test('never writes the password into the error message', async () => {
  await withServer(async (client) => {
    const err = await client.login('user', 'hunter2-secret').catch((e) => e);
    assert.ok(err instanceof ImapError);
    assert.ok(!String(err.message).includes('hunter2-secret'), 'password leaked into error text');
    assert.ok(!String(err.stack).includes('hunter2-secret'), 'password leaked into stack');
  });
});

test('SELECT reports UIDVALIDITY and message count', async () => {
  await withServer(async (client) => {
    await client.login('user', 'pass');
    const box = await client.select('INBOX');
    assert.strictEqual(box.uidValidity, 90210);
    assert.strictEqual(box.exists, fx.ALL.length);
  });
});

test('discovers special-use folders from LIST flags', async () => {
  await withServer(async (client) => {
    await client.login('user', 'pass');
    const folders = await client.specialFolders();
    assert.strictEqual(folders.sent, 'Sent');
    assert.strictEqual(folders.drafts, 'Drafts');
    assert.strictEqual(folders.archive, 'Archive');
  });
});

test('falls back to name matching when SPECIAL-USE flags are absent', async () => {
  await withServer(
    async (client) => {
      await client.login('user', 'pass');
      const folders = await client.specialFolders();
      assert.strictEqual(folders.sent, '[Gmail]/Sent Mail');
      assert.strictEqual(folders.drafts, '[Gmail]/Drafts');
    },
    {
      folders: [
        { name: 'INBOX', flags: [] },
        { name: '[Gmail]/Sent Mail', flags: [] },
        { name: '[Gmail]/Drafts', flags: [] },
      ],
    }
  );
});

test('UID SEARCH returns matching uids', async () => {
  await withServer(async (client) => {
    await client.login('user', 'pass');
    await client.select('INBOX');
    const uids = await client.search('ALL');
    assert.deepStrictEqual(uids, fx.ALL.map((m) => m.uid));
  });
});

test('UID FETCH round-trips headers delivered as literals', async () => {
  await withServer(async (client) => {
    await client.login('user', 'pass');
    await client.select('INBOX');
    const fetched = await client.fetch([101, 103]);

    assert.strictEqual(fetched.length, 2);
    const dana = fetched.find((m) => m.uid === 103);
    assert.ok(dana.raw.includes('Dana Whitfield'), 'literal body did not round-trip');
    assert.ok(dana.internalDate instanceof Date);
    assert.ok(dana.size > 0);
  });
});

test('UID FETCH of the full body preserves the multipart structure', async () => {
  await withServer(async (client) => {
    await client.login('user', 'pass');
    await client.select('INBOX');
    const [message] = await client.fetch([106], '(UID BODY.PEEK[])');
    assert.ok(message.raw.includes('--OUTER'), 'multipart boundary lost in transit');
    assert.ok(message.raw.includes('q3.xlsx'));
  });
});

test('fetch uses BODY.PEEK so reading does not mark mail as seen', async () => {
  await withServer(async (client, server) => {
    await client.login('user', 'pass');
    await client.select('INBOX');
    await client.fetch([101]);
    const fetchCommand = server.commandLog.find((l) => l.includes('UID FETCH'));
    assert.match(fetchCommand, /BODY\.PEEK/, 'fetch would have marked mail \\Seen');
  });
});

test('storeFlags sets flags and refuses \\Deleted', async () => {
  await withServer(async (client, server) => {
    await client.login('user', 'pass');
    await client.select('INBOX');

    await client.storeFlags([101], ['\\Flagged']);
    assert.strictEqual(server.storedFlags.length, 1);
    assert.deepStrictEqual(server.storedFlags[0].flags, ['\\Flagged']);

    await assert.rejects(
      () => client.storeFlags([101], ['\\Deleted']),
      /never deletes mail/
    );
    // The refusal must happen client-side, before anything reaches the server.
    assert.strictEqual(server.storedFlags.length, 1);
  });
});

test('copyMessage files mail without touching the original', async () => {
  await withServer(async (client, server) => {
    await client.login('user', 'pass');
    await client.select('INBOX');
    await client.copyMessage([101, 102], 'Archive');

    assert.strictEqual(server.copied.length, 1);
    assert.deepStrictEqual(server.copied[0].uids.sort((a, b) => a - b), [101, 102]);
    assert.strictEqual(server.copied[0].destination, 'Archive');
  });
});

test('APPEND completes the literal continuation handshake', async () => {
  await withServer(async (client, server) => {
    await client.login('user', 'pass');
    const draft = 'From: alice@example.com\nTo: dana@partnerco.example\nSubject: Re: contract\n\nOn it.';
    await client.append('Drafts', draft);

    assert.strictEqual(server.appended.length, 1);
    assert.strictEqual(server.appended[0].mailbox, 'Drafts');
    assert.deepStrictEqual(server.appended[0].flags, ['\\Draft']);
    assert.match(server.appended[0].body, /Subject: Re: contract/);
    // Line endings must be normalized to CRLF on the wire.
    assert.ok(server.appended[0].body.includes('\r\n'), 'APPEND body was not CRLF-normalized');
  });
});

test('commands are serialized rather than interleaved', async () => {
  await withServer(async (client, server) => {
    await client.login('user', 'pass');
    await client.select('INBOX');
    // Fire concurrently; the client must still issue them one at a time.
    await Promise.all([client.noop(), client.noop(), client.noop()]);
    const noops = server.commandLog.filter((l) => l.includes('NOOP'));
    assert.strictEqual(noops.length, 3);
    const tags = noops.map((l) => l.split(' ')[0]);
    assert.strictEqual(new Set(tags).size, 3, 'tags must be unique per command');
  });
});

test('an empty uid list short-circuits without hitting the server', async () => {
  await withServer(async (client, server) => {
    await client.login('user', 'pass');
    await client.select('INBOX');
    const before = server.commandLog.length;
    assert.deepStrictEqual(await client.fetch([]), []);
    await client.storeFlags([], ['\\Flagged']);
    await client.copyMessage([], 'Archive');
    assert.strictEqual(server.commandLog.length, before, 'sent a command for an empty set');
  });
});
