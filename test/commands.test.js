import assert from 'node:assert/strict';
import test, { describe, before } from 'node:test';

import { matchCommand, runCommand, matchHush } from '../src/agent/commands.js';
import { config } from '../src/config.js';

before(() => {
  config.values.agentNames = 'mirror, espejo, sombrero';
  config.values.musicChannel = '';
});

describe('matchCommand: the commands a person says in one breath', () => {
  const cases = [
    ['espejo, saltá', { kind: 'skip' }],
    ['Espejo, salteá este tema.', { kind: 'skip' }],
    ['mirror skip', { kind: 'skip' }],
    ['espejo, siguiente', { kind: 'skip' }],
    ['espejo pasá de tema', { kind: 'skip' }],
    ['espejo, pará la música', { kind: 'stop' }],
    ['espejo, pará', { kind: 'stop' }],
    ['sombrero, stop', { kind: 'stop' }],
    ['espejo, pará un segundo', { kind: 'pause' }],
    ['espejo, pausá', { kind: 'pause' }],
    ['espejo, pausala', { kind: 'pause' }],
    ['espejo, reanudá', { kind: 'resume' }],
    ['espejo, seguí con la música', { kind: 'resume' }],
    ['espejo, bajá un poco el volumen', { kind: 'volume', change: -10 }],
    ['espejo, bajá la música', { kind: 'volume', change: -15 }],
    ['espejo, subile bastante al volumen', { kind: 'volume', change: 30 }],
    ['espejo, más fuerte', { kind: 'volume', change: 15 }],
    ['espejo, ponelo al 30', { kind: 'volume', level: 30 }],
    ['espejo, volumen 80', { kind: 'volume', level: 80 }],
  ];
  for (const [said, expected] of cases) {
    test(`"${said}"`, () => {
      assert.deepEqual(matchCommand(said), expected);
    });
  }

  const notCommands = [
    'espejo, seguí',
    'seguí contando',
    'espejo, saltá la parte aburrida de la peli',
    'espejo, poné algo de los redondos',
    'espejo, qué tema es este',
    'espejo, pará de hablar',
    'bajá al canal de al lado',
    'espejo, subí una foto',
    'espejo, cuánto es 30 más 80',
    'They said your name but nothing else. Ask what they want, in a few words.',
    '',
  ];
  for (const said of notCommands) {
    test(`not a command: "${said}"`, () => {
      assert.equal(matchCommand(said), null);
    });
  }
});

describe('runCommand: the same effect and note the tool has', () => {
  function fakeSession({ playing = true, queue = [] } = {}) {
    const calls = [];
    return {
      calls,
      client: null,
      music: {
        playing,
        queue,
        skip: () => {
          calls.push('skip');
          return playing ? { title: 'Track 1' } : null;
        },
        stop: () => calls.push('stop'),
        pause: () => {
          calls.push('pause');
          return playing;
        },
        resume: () => {
          calls.push('resume');
          return !playing;
        },
        setVolume: ({ change, level }) => {
          calls.push(`volume ${change ?? `=${level}`}`);
          const to = level ?? 50 + change;
          return { from: 50, to, applied: playing, atLimit: false };
        },
      },
    };
  }
  const turn = { guildId: 'g', askedBy: 'Vero' };

  test('skip, stop, pause and volume run and report the tool they stood in for', async () => {
    const s = fakeSession({ queue: [{ title: 'Track 2' }] });
    assert.equal(await runCommand({ kind: 'skip' }, { session: s, ...turn }), 'mcp__bot__skip_song');
    assert.equal(await runCommand({ kind: 'stop' }, { session: s, ...turn }), 'mcp__bot__stop_music');
    assert.equal(await runCommand({ kind: 'pause' }, { session: s, ...turn }), 'mcp__bot__pause_music');
    assert.equal(await runCommand({ kind: 'volume', change: -15 }, { session: s, ...turn }), 'mcp__bot__set_volume');
    assert.deepEqual(s.calls, ['skip', 'stop', 'pause', 'volume -15']);
  });

  test('with nothing to act on, it steps aside and the model has the question', async () => {
    const s = fakeSession({ playing: false });
    assert.equal(await runCommand({ kind: 'skip' }, { session: s, ...turn }), null);
    assert.equal(await runCommand({ kind: 'stop' }, { session: s, ...turn }), null);
    assert.equal(await runCommand({ kind: 'pause' }, { session: s, ...turn }), null);
    assert.equal(await runCommand({ kind: 'volume', change: 15 }, { session: s, ...turn }), null);
    assert.equal(await runCommand({ kind: 'resume' }, { session: s, ...turn }), 'mcp__bot__resume_music');
  });

  test('a session without music is left alone', async () => {
    assert.equal(await runCommand({ kind: 'skip' }, { session: {}, ...turn }), null);
    assert.equal(await runCommand({ kind: 'skip' }, { session: null, ...turn }), null);
  });
});

describe('matchHush', () => {
  for (const said of ['espejo, basta', 'mirror shh', 'espejo callate', 'espejo, pará de hablar', 'sombrero, silencio', 'mirror, stop talking', 'mirror shut up', 'espejo ya basta', 'espejo, cortala']) {
    test(`hush: "${said}"`, () => assert.equal(matchHush(said), true));
  }
  for (const said of ['espejo, basta de hablar de fútbol', 'espejo, qué opinás', 'espejo, pará la música', 'espejo', 'stop the music please', '']) {
    test(`not a hush: "${said}"`, () => assert.equal(matchHush(said), false));
  }
});
