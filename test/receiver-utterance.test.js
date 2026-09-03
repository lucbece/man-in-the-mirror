import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { VoiceReceiver } from '../src/voice/receiver.js';

/** Discord's receiver, reduced to what VoiceReceiver touches. */
function fakeConnection() {
  const streams = new Map();
  return {
    streams,
    receiver: {
      speaking: new EventEmitter(),
      subscriptions: new Map(),
      subscribe(userId) {
        const stream = new EventEmitter();
        stream.destroy = () => {
          stream.destroyed = true;
        };
        streams.set(userId, stream);
        return stream;
      },
    },
  };
}

function fakeClient() {
  return {
    guilds: {
      cache: new Map([
        ['g1', { members: { cache: new Map([['u1', { displayName: 'Vero', user: {} }]]) } }],
      ]),
    },
  };
}

/** Discord sends 20ms per Opus frame, so N packets is N*20 milliseconds. */
const packetsFor = (ms) => ms / 20;

function startCapturing() {
  const connection = fakeConnection();
  const receiver = new VoiceReceiver(connection, { guildId: 'g1', client: fakeClient() });
  receiver.start();
  const emitted = [];
  receiver.on('utterance', (u) => emitted.push(u));
  connection.receiver.speaking.emit('start', 'u1');
  return { receiver, emitted, stream: connection.streams.get('u1') };
}

describe('long utterances', () => {
  test('a normal utterance is buffered and emitted', () => {
    const { receiver, emitted, stream } = startCapturing();
    for (let i = 0; i < packetsFor(3000); i++) stream.emit('data', Buffer.alloc(20));
    stream.emit('end');

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].durationMs, 3000);
    assert.equal(receiver.buffer.utterances.length, 1);
  });

  test('one that runs past the cap is kept, not discarded', () => {
    // The bug: reaching the cap dropped the whole utterance — not buffered,
    // not emitted, not logged — so a minute of speech vanished silently.
    const { receiver, emitted, stream } = startCapturing();
    for (let i = 0; i < packetsFor(75_000); i++) stream.emit('data', Buffer.alloc(20));

    assert.equal(emitted.length, 1, 'should still be emitted');
    assert.equal(receiver.buffer.utterances.length, 1, 'should still be buffered');
    assert.ok(emitted[0].durationMs >= 59_000, 'should keep what it captured');
    assert.ok(emitted[0].durationMs <= 61_000, 'should stop at the cap');
  });

  test('packets stop accumulating once capped', () => {
    // The other half: the packets kept arriving into memory with no bound
    // until the stream chose to end, which for a continuously noisy microphone
    // could be a long time.
    const { emitted, stream } = startCapturing();
    for (let i = 0; i < packetsFor(75_000); i++) stream.emit('data', Buffer.alloc(20));
    const atCap = emitted[0].packets.length;

    for (let i = 0; i < 500; i++) stream.emit('data', Buffer.alloc(20));
    assert.equal(emitted[0].packets.length, atCap, 'must not grow after the cap');
  });

  test('the subscription is torn down at the cap', () => {
    const { stream } = startCapturing();
    for (let i = 0; i < packetsFor(75_000); i++) stream.emit('data', Buffer.alloc(20));
    assert.equal(stream.destroyed, true);
  });

  test('a capped utterance is emitted exactly once', () => {
    // finish() runs at the cap and again on 'end'; emitting twice would put
    // the same audio through transcription and wake detection a second time.
    const { emitted, stream } = startCapturing();
    for (let i = 0; i < packetsFor(75_000); i++) stream.emit('data', Buffer.alloc(20));
    stream.emit('end');
    assert.equal(emitted.length, 1);
  });

  test('an errored stream still keeps what it captured', () => {
    const { emitted, stream } = startCapturing();
    for (let i = 0; i < packetsFor(2000); i++) stream.emit('data', Buffer.alloc(20));
    stream.emit('error', new Error('connection reset'));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].durationMs, 2000);
  });
});
