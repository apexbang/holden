#!/usr/bin/env node
'use strict';
// A scripted stand-in for `codex app-server`, put on PATH as `codex`: no network, no Codex plan.
// It copies what real turns showed on CLI 0.166.0: one SIGTERM waits for a running turn, the server
// runs an ephemeral thread of its own, and a turn can carry commentary before its final answer.
// FAKE_CODEX picks the script: ok, commentary, early, request, hang, deaf, interrupted, failed, empty,
// die, dielater, nostart, noanswer, noid, noreply, otherid, oldversion. Every request and signal goes to FAKE_CODEX_LOG as a
// JSON line; FAKE_CODEX_PID, when set, gets this pid; FAKE_TURN_MS holds an ok turn open that long; FAKE_ANSWER_PID names this server in the answer, for rounds that run at once.
const crypto = require('crypto'), fs = require('fs'), http = require('http');

const ID = process.env.FAKE_THREAD_ID || '01a15563-0000-7000-8000-000000000001', TURN = 'turn-1', mode = process.env.FAKE_CODEX || 'ok';
const VERSION = mode === 'oldversion' ? '0.150.0' : '0.166.0';
const logf = process.env.FAKE_CODEX_LOG;
const log = o => { if (logf) fs.appendFileSync(logf, JSON.stringify(o) + '\n'); };
const argv = process.argv.slice(2);
// Only the websocket form is scripted; the stdio read of a usage line finds nothing and says so.
if (argv[0] !== 'app-server' || !argv.includes('--listen')) { log({ argv }); process.exit(0); }
if (process.env.FAKE_CODEX_PID) fs.writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
if (mode === 'nostart') { console.error('fake: address in use'); process.exit(3); }
const port = Number(argv[argv.indexOf('--listen') + 1].split(':').pop());

let running = false, sock = null, buf = Buffer.alloc(0);
process.on('SIGTERM', () => {
  log({ signal: 'SIGTERM', running });
  if (!running) process.exit(0);
});

function frame(text) {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length])
    : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255])
    : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(p.length); return b; })()]);
  return Buffer.concat([head, p]);
}
const send = o => sock.write(frame(JSON.stringify(o)));
const note = (method, params) => send({ method, params });

const answer = t => ({ type: 'agentMessage', id: 'msg-final', text: t, phase: 'final_answer' });
const turn = (status, items = [], error = null) => ({ id: TURN, items, status, error });
function complete(status, items, error) { running = false; note('turn/completed', { threadId: ID, turn: turn(status, items, error) }); }
const turnCount = () => logf ? fs.readFileSync(logf, 'utf8').split('\n').filter(l => l.includes('"method":"turn/start"')).length : 1;

function onTurnStart(msg) {
  running = true;
  const text = process.env.FAKE_ANSWER_PID ? `answer from ${process.pid}` : `answer ${turnCount()}`;
  if (mode === 'early') { note('item/completed', { threadId: ID, turnId: TURN, item: answer(text) }); complete('completed', [answer(text)]); send({ id: msg.id, result: { turn: turn('inProgress') } }); return; }
  // The turn runs, but turn/start's reply never comes: the turn's id is known only from turn/started.
  if (mode === 'noreply') { note('turn/started', { threadId: 'helper-thread', turn: { id: 'turn-x', items: [], status: 'inProgress', error: null } }); note('turn/started', { threadId: ID, turn: turn('inProgress') }); return; }
  send({ id: msg.id, result: { turn: turn('inProgress') } });
  note('turn/started', { threadId: ID, turn: turn('inProgress') });
  switch (mode) {
    case 'hang': case 'deaf': return;
    case 'die': process.exit(9); break;
    case 'dielater': setTimeout(() => process.exit(9), 300); return;
    case 'interrupted': complete('interrupted', []); return;
    case 'failed': complete('failed', [], { message: 'model refused' }); return;
    case 'empty': complete('completed', []); return;
    case 'noanswer': complete('completed', [{ type: 'agentMessage', id: 'msg-c', text: 'looking', phase: 'commentary' }]); return;
    case 'request': send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: ID } }); return;
    case 'commentary':
      // Another thread's end, then this turn's commentary: neither is the answer.
      note('turn/completed', { threadId: 'helper-thread', turn: { id: 'turn-x', items: [answer('not the answer')], status: 'completed', error: null } });
      note('item/completed', { threadId: 'helper-thread', turnId: 'turn-x', item: answer('not the answer') });
      note('item/completed', { threadId: ID, turnId: TURN, item: { type: 'agentMessage', id: 'msg-c', text: 'looking', phase: 'commentary' } });
      note('item/completed', { threadId: ID, turnId: TURN, item: answer(text) });
      complete('completed', [answer(text)]);
      return;
    default:
      setTimeout(() => {
        note('item/completed', { threadId: ID, turnId: TURN, item: answer(text) });
        complete('completed', [answer(text)]);
      }, Number(process.env.FAKE_TURN_MS || 0));
  }
}

function onMessage(text) {
  const m = JSON.parse(text);
  log({ method: m.method, params: m.params, cwd: process.cwd() });
  if (m.id === 900) { note('item/completed', { threadId: ID, turnId: TURN, item: answer('after the request') }); complete('completed', [answer('after the request')]); return; }
  switch (m.method) {
    case 'initialize': send({ id: m.id, result: { userAgent: `holden/${VERSION} (Fake 1; x86_64) (holden; 1)`, platformFamily: 'unix', platformOs: 'linux' } }); break;
    case 'initialized': break;
    case 'thread/start': send({ id: m.id, result: { thread: mode === 'noid' ? {} : { id: ID }, cwd: m.params.cwd } }); note('thread/started', { thread: { id: 'helper-thread', ephemeral: true } }); break;
    case 'thread/resume': send({ id: m.id, result: { thread: { id: mode === 'otherid' ? '01a1ffff-0000-7000-8000-000000000000' : m.params.threadId }, cwd: m.params.cwd } }); break;
    case 'turn/start': onTurnStart(m); break;
    case 'turn/interrupt':
      if (mode === 'deaf') return;
      send({ id: m.id, result: {} }); complete('interrupted', []); break;
    default: send({ id: m.id, error: { code: -32601, message: `fake: no ${m.method}` } });
  }
}

function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 2) {
    const op = buf[0] & 15; let len = buf[1] & 127, at = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
    if (buf.length < at + 4 + len) return;
    const mask = buf.subarray(at, at + 4), data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    buf = buf.subarray(at + 4 + len);
    if (op === 8) { log({ closed: true, running }); sock.end(); return; }
    if (op === 1) onMessage(data.toString());
  }
}

const srv = http.createServer((q, r) => { r.writeHead(404); r.end(); });
srv.on('upgrade', (req, s) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock = s; s.on('data', onData); s.on('error', () => {}); s.on('close', () => { sock = null; });
});
srv.listen(port, '127.0.0.1');
