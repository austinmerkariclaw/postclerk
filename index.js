'use strict';

/**
 * postclerk — a local-first AI chief of staff for your inbox.
 *
 * The library surface, for embedding or scripting. The CLI in bin/cli.js is
 * built entirely on top of these exports and adds no logic of its own.
 */

module.exports = {
  // transport
  Mailbox: require('./lib/mailbox').Mailbox,
  ImapClient: require('./lib/imap/client').ImapClient,

  // parsing
  mime: require('./lib/mime'),
  message: require('./lib/message'),

  // triage
  cascade: require('./lib/triage/cascade'),
  signals: require('./lib/triage/signals'),
  correspondents: require('./lib/triage/correspondents'),

  // model layer
  llm: require('./lib/llm'),
  redact: require('./lib/llm/redact'),
  project: require('./lib/llm/project'),

  // pipeline
  run: require('./lib/run'),
  backtest: require('./lib/backtest').backtest,

  // state
  store: require('./lib/store'),
  report: require('./lib/report'),
};
