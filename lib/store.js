'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { CorrespondentGraph } = require('./triage/correspondents');

/**
 * Local state. Everything is a plain file the user can read, diff, or delete.
 *
 * There is no database and no binary format, deliberately. A tool that reads
 * your whole inbox should not also be opaque about what it remembers — and
 * `voice.md` being editable Markdown means you can correct how the system
 * thinks you write, which you cannot do with a hosted competitor.
 */

const DEFAULT_CONFIG = {
  version: 1,
  imap: {
    host: '',
    port: 993,
    user: '',
    /** Never store the password here. Resolved from env or passwordFile. */
    passwordFile: '',
  },
  self: [],
  folders: {
    inbox: 'INBOX',
    sent: null,     // auto-detected when null
    drafts: null,
    /** Where triaged mail is filed. Created by the user, never by us. */
    later: 'postclerk/Later',
    brief: 'postclerk/Brief',
    noise: 'postclerk/Noise',
  },
  triage: {
    escalateBelow: 0.75,
    knownCorrespondentMinSent: 3,
    knownCorrespondentMaxAgeDays: 180,
    neverAnsweredMinReceived: 5,
    batchSize: 10,
    lookbackDays: 7,
  },
  llm: {
    provider: 'none',        // none | anthropic | ollama
    model: 'claude-opus-5',
    endpoint: '',
    bodyChars: 2000,
    effort: 'low',
  },
  rules: {
    vips: [],
    muted: [],
  },
};

function home() {
  return process.env.POSTCLERK_HOME || path.join(os.homedir(), '.postclerk');
}

function paths() {
  const root = home();
  return {
    root,
    config: path.join(root, 'config.json'),
    state: path.join(root, 'state'),
    correspondents: path.join(root, 'state', 'correspondents.json'),
    messages: path.join(root, 'state', 'messages.jsonl'),
    uidvalidity: path.join(root, 'state', 'uidvalidity.json'),
    journal: path.join(root, 'journal.jsonl'),
    voice: path.join(root, 'voice.md'),
    lock: path.join(root, 'lock'),
  };
}

function ensureDirs() {
  const p = paths();
  fs.mkdirSync(p.state, { recursive: true });
  return p;
}

// ------------------------------------------------------------------- config

function loadConfig() {
  const p = paths();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config at ${p.config} is not valid JSON: ${err.message}`);
  }
  return deepMerge(DEFAULT_CONFIG, stored);
}

function saveConfig(config) {
  const p = ensureDirs();
  const serialized = JSON.stringify(config, null, 2);
  fs.writeFileSync(p.config, serialized, { mode: 0o600 });
  hardenPermissions(p.config);
  return p.config;
}

/**
 * Resolve the mailbox password.
 *
 * Order: environment, then a referenced file. It is never read from config.json
 * and never written anywhere by us — the credential is the crown jewel here
 * (ADR-001), and an app password grants full mailbox access with no scoping.
 */
function resolvePassword(config) {
  if (process.env.POSTCLERK_PASSWORD) return process.env.POSTCLERK_PASSWORD;

  const file = config?.imap?.passwordFile;
  if (file) {
    const resolved = file.startsWith('~')
      ? path.join(os.homedir(), file.slice(1))
      : file;
    try {
      return fs.readFileSync(resolved, 'utf8').trim();
    } catch (err) {
      throw new Error(`could not read passwordFile ${resolved}: ${err.message}`);
    }
  }

  throw new Error(
    'no mailbox password available. Set POSTCLERK_PASSWORD in the environment, ' +
    'or point imap.passwordFile at a file containing it.'
  );
}

// -------------------------------------------------------------- correspondents

function loadGraph(config) {
  const p = paths();
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(p.correspondents, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const graph = CorrespondentGraph.fromJSON(data);

  // Rules from config always win over whatever is cached in state.
  graph.vips = new Set((config?.rules?.vips || []).map((v) => String(v).toLowerCase()));
  graph.muted = new Set((config?.rules?.muted || []).map((v) => String(v).toLowerCase()));
  return graph;
}

function saveGraph(graph) {
  const p = ensureDirs();
  writeAtomic(p.correspondents, JSON.stringify(graph.toJSON()));
  return p.correspondents;
}

// -------------------------------------------------------------- header cache

/** Ceiling on the header cache. Beyond this it is compacted, oldest first. */
const MAX_CACHED_MESSAGES = 20000;

/**
 * Cache message headers so `backtest` can replay history without refetching a
 * month of mail on every run.
 *
 * The cache is append-only for speed, which means a long-running scheduled
 * install would grow it without bound — a slow storage-exhaustion bug that only
 * shows up months later on someone else's machine. So writes past a threshold
 * trigger a compaction: dedupe by message id, keep the newest N, rewrite.
 */
function saveMessages(messages, { append = true } = {}) {
  const p = ensureDirs();
  const lines = messages.map((m) => JSON.stringify(serializeMessage(m))).join('\n');
  if (!lines) return p.messages;

  if (!append) {
    fs.writeFileSync(p.messages, `${lines}\n`);
    return p.messages;
  }

  fs.appendFileSync(p.messages, `${lines}\n`);

  // Cheap check: count lines only when the file is big enough to matter.
  let stat;
  try { stat = fs.statSync(p.messages); } catch { return p.messages; }
  if (stat.size < 8 * 1024 * 1024) return p.messages;

  compactMessageCache();
  return p.messages;
}

/** Dedupe by message id and keep only the newest MAX_CACHED_MESSAGES. */
function compactMessageCache(limit = MAX_CACHED_MESSAGES) {
  const p = paths();
  const messages = loadMessages(); // already deduped by id
  if (messages.length <= limit) {
    // Still rewrite: dedupe alone may have shrunk it substantially.
    if (messages.length === 0) return 0;
    fs.writeFileSync(p.messages, `${messages.map((m) => JSON.stringify(serializeMessage(m))).join('\n')}\n`);
    return messages.length;
  }

  const kept = messages
    .sort((a, b) => a.date - b.date)
    .slice(-limit);
  fs.writeFileSync(p.messages, `${kept.map((m) => JSON.stringify(serializeMessage(m))).join('\n')}\n`);
  return kept.length;
}

function loadMessages() {
  const p = paths();
  let raw = '';
  try {
    raw = fs.readFileSync(p.messages, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const message = deserializeMessage(JSON.parse(line));
      // Later entries win: re-fetching a message updates its flags.
      byId.set(message.messageId || `uid:${message.uid}`, message);
    } catch {
      continue; // a partially-written line is not a reason to lose the cache
    }
  }
  return [...byId.values()];
}

function serializeMessage(m) {
  return {
    uid: m.uid,
    folder: m.folder,
    messageId: m.messageId,
    threadId: m.threadId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    flags: m.flags,
    size: m.size,
    headers: Object.fromEntries(m.headers || []),
    bodyText: (m.bodyText || '').slice(0, 4000),
    attachments: m.attachments || [],
    hasBody: Boolean(m.hasBody),
  };
}

function deserializeMessage(o) {
  return {
    ...o,
    date: new Date(o.date),
    headers: new Map(Object.entries(o.headers || {})),
    to: o.to || [],
    cc: o.cc || [],
    replyTo: o.replyTo || [],
    flags: o.flags || [],
    attachments: o.attachments || [],
    bodyText: o.bodyText || '',
  };
}

function loadUidValidity() {
  const p = paths();
  try { return JSON.parse(fs.readFileSync(p.uidvalidity, 'utf8')); }
  catch { return {}; }
}

/**
 * A changed UIDVALIDITY means the server recreated the folder and every cached
 * UID now points at the wrong message — or nothing. Detect it and discard.
 */
function checkUidValidity(folder, value) {
  const p = ensureDirs();
  const stored = loadUidValidity();
  const previous = stored[folder];
  stored[folder] = value;
  writeAtomic(p.uidvalidity, JSON.stringify(stored, null, 2));
  return { changed: previous !== undefined && previous !== value, previous };
}

function clearMessageCache() {
  const p = paths();
  try { fs.unlinkSync(p.messages); } catch { /* nothing cached */ }
}

// ------------------------------------------------------------------- journal

/**
 * Append-only journal. Every mutation records its own inverse.
 *
 * Intent is written and flushed to disk *before* the mailbox is touched, so a
 * crash mid-apply still leaves enough on disk for `undo` to reverse what
 * happened. Writing the journal afterwards would create precisely the window
 * where mail has moved and nothing knows how to move it back (design §2).
 */
class Journal {
  constructor(file = null) {
    this.file = file || paths().journal;
  }

  static newRunId() {
    return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  }

  _append(entry, { durable = false } = {}) {
    ensureDirs();
    const line = `${JSON.stringify(entry)}\n`;
    if (!durable) {
      fs.appendFileSync(this.file, line);
      return entry;
    }
    // Durable path: write and fsync so the record survives a hard crash.
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return entry;
  }

  /** Record what we are about to do. Durable by design. */
  writeIntent(runId, actions) {
    return this._append({
      runId,
      ts: new Date().toISOString(),
      phase: 'intent',
      actions: actions.map(normalizeAction),
    }, { durable: true });
  }

  /** Record what actually happened. */
  writeResult(runId, action, { applied, error = null }) {
    return this._append({
      runId,
      ts: new Date().toISOString(),
      phase: 'result',
      action: normalizeAction(action),
      applied,
      error: error ? String(error.message || error).slice(0, 500) : null,
    });
  }

  writeNote(runId, note) {
    return this._append({ runId, ts: new Date().toISOString(), phase: 'note', ...note });
  }

  entries() {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }

    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { continue; }
    }
    return out;
  }

  runs() {
    const byRun = new Map();
    for (const entry of this.entries()) {
      const run = byRun.get(entry.runId) || { runId: entry.runId, ts: entry.ts, intents: [], results: [], undone: false };
      if (entry.phase === 'intent') run.intents.push(...(entry.actions || []));
      if (entry.phase === 'result') run.results.push(entry);
      if (entry.phase === 'note' && entry.type === 'undo') run.undone = true;
      byRun.set(entry.runId, run);
    }
    return [...byRun.values()];
  }

  /** The most recent run that changed the mailbox and has not been undone. */
  lastAppliedRun() {
    const runs = this.runs().filter((r) => !r.undone && r.intents.length > 0);
    return runs.length ? runs[runs.length - 1] : null;
  }

  /**
   * Runs with recorded intent but no matching result — i.e. we crashed
   * mid-apply. `undo` can still reverse these; `doctor` reports them.
   */
  orphanedRuns() {
    return this.runs().filter((run) => {
      if (run.undone || run.intents.length === 0) return false;
      const succeeded = run.results.filter((r) => r.applied).length;
      return succeeded < run.intents.length;
    });
  }

  markUndone(runId, reversed) {
    return this.writeNote(runId, { type: 'undo', reversed, undoneAt: new Date().toISOString() });
  }
}

function normalizeAction(action) {
  return {
    action: action.action,
    uid: action.uid,
    messageId: action.messageId || '',
    from: action.from || '',
    to: action.to || '',
    flags: action.flags || [],
    label: action.label || '',
  };
}

/** Invert an action: this is what makes every mutation reversible (ADR-005). */
function invertAction(action) {
  if (action.action === 'move') {
    return { ...action, from: action.to, to: action.from };
  }
  if (action.action === 'flag') {
    return { ...action, action: 'unflag' };
  }
  if (action.action === 'unflag') {
    return { ...action, action: 'flag' };
  }
  return null; // 'draft' creates a draft; reversing it would delete mail
}

// ---------------------------------------------------------------------- voice

const VOICE_TEMPLATE = `# Voice profile

postclerk learned this from your Sent folder. It is a plain file — edit it
freely. Anything you write here overrides what was inferred.

## Observed
_(nothing learned yet — run \`postclerk init\`)_
`;

function loadVoice() {
  const p = paths();
  try { return fs.readFileSync(p.voice, 'utf8'); }
  catch { return VOICE_TEMPLATE; }
}

function saveVoice(text) {
  const p = ensureDirs();
  fs.writeFileSync(p.voice, text, { mode: 0o600 });
  return p.voice;
}

// ----------------------------------------------------------------------- lock

/**
 * Prevent two runs from applying at once. A scheduled run and a manual one
 * colliding could double-file mail; failing loudly is better.
 */
function acquireLock() {
  const p = ensureDirs();
  try {
    const fd = fs.openSync(p.lock, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return { release: () => { try { fs.unlinkSync(p.lock); } catch { /* already gone */ } } };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    // A lock from a dead process is stale, not a conflict.
    let holder = {};
    try { holder = JSON.parse(fs.readFileSync(p.lock, 'utf8')); } catch { /* unreadable */ }
    if (holder.pid && !isProcessAlive(holder.pid)) {
      fs.unlinkSync(p.lock);
      return acquireLock();
    }
    throw new Error(
      `another postclerk run is in progress (pid ${holder.pid || 'unknown'}). ` +
      `If that is wrong, remove ${p.lock}.`
    );
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

// ---------------------------------------------------------------------- utils

function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
  hardenPermissions(file);
}

function hardenPermissions(file) {
  // Best-effort: chmod is a no-op on Windows, which is fine — the file still
  // lives under the user's profile directory.
  try { fs.chmodSync(file, 0o600); } catch { /* platform does not support it */ }
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

module.exports = {
  DEFAULT_CONFIG,
  home,
  paths,
  ensureDirs,
  loadConfig,
  saveConfig,
  resolvePassword,
  loadGraph,
  saveGraph,
  saveMessages,
  loadMessages,
  clearMessageCache,
  compactMessageCache,
  MAX_CACHED_MESSAGES,
  checkUidValidity,
  loadUidValidity,
  Journal,
  invertAction,
  normalizeAction,
  loadVoice,
  saveVoice,
  VOICE_TEMPLATE,
  acquireLock,
  deepMerge,
};
