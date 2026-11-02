import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CLIENT_MESSAGES, LIMITS } from '../../shared/protocol.js';
import { SequencedInbox } from '../../shared/sequenced-inbox.js';
import { parseClientMessage, TokenBucket } from '../src/validation.js';

const wrap = (type, payload) => JSON.stringify({ id: randomUUID(), type, payload });

test('chaque exemple du contrat passe la validation réelle', () => {
  for (const [type, def] of Object.entries(CLIENT_MESSAGES)) {
    const r = parseClientMessage(wrap(type, def.example));
    assert.equal(r.ok, true, `${type} : ${r.message}`);
  }
});

test('entrées hostiles rejetées sans exception', () => {
  const cases = [
    ['{pas du json', 'BAD_JSON'], ['null', 'INVALID_MESSAGE'], ['[]', 'INVALID_MESSAGE'], ['42', 'INVALID_MESSAGE'],
    [JSON.stringify({ id: 'x', type: 'sys.ping', payload: {} }), 'INVALID_MESSAGE'],
    [wrap('admin.drop', {}), 'UNKNOWN_TYPE'],
    [wrap('game.fire', { gameId: randomUUID(), x: 10, y: 0 }), 'INVALID_MESSAGE'],
    [wrap('game.fire', { gameId: randomUUID(), x: 1, y: 0, hack: true }), 'INVALID_MESSAGE'],
    [wrap('chat.send', { gameId: randomUUID(), text: 'x'.repeat(201) }), 'INVALID_MESSAGE'],
    ['x'.repeat(LIMITS.MAX_MESSAGE_BYTES + 1), 'TOO_LARGE'],
  ];
  for (const [raw, code] of cases) assert.equal(parseClientMessage(raw).code, code, raw.slice(0, 40));
});

test('seau à jetons : rafale tolérée, débit moyen limité', () => {
  const b = new TokenBucket(10, 5, 0);
  assert.equal(Array.from({ length: 6 }, () => b.take(0)).filter(Boolean).length, 5);
  assert.equal(b.take(50), false);
  assert.equal(b.take(200), true);
});

const collect = (lastSeq = 0) => {
  const out = [];
  return { out, inbox: new SequencedInbox({ lastSeq, onEvent: (e) => out.push(e.seq), gapTimeoutMs: 5 }) };
};

test('doublons ignorés, livraison unique', () => {
  const { out, inbox } = collect();
  [1, 2, 2, 1, 3].forEach((seq) => inbox.push({ seq }));
  assert.deepEqual(out, [1, 2, 3]);
  assert.equal(inbox.duplicates, 2);
});

test('désordre remis en ordre', () => {
  const { out, inbox } = collect();
  [3, 1, 2, 5, 4].forEach((seq) => inbox.push({ seq }));
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.equal(inbox.reordered, 2);
});

test('un trou persistant déclenche une demande de reprise', async () => {
  let asked = null;
  const inbox = new SequencedInbox({ lastSeq: 4, onEvent() {}, onGap: (s) => { asked = s; }, gapTimeoutMs: 5 });
  inbox.push({ seq: 7 });
  await new Promise((r) => { setTimeout(r, 20); });
  assert.equal(asked, 4);
});
