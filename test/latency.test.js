import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'deploy', 'latency.sh');

// Real lines from one evening's log, as they appear with a compose prefix and
// without one. The script must find the numbers either way.
const LINES = [
  'mirror-1  | [agent] answered in 10.4s (heard 1.7s, first words at 2.0s, thought through 3.5s) · no tools · 4.7s of that was before the model was asked',
  '[agent] answered in 7.2s (heard 2.3s, first words at 2.7s, thought through 2.7s) · no tools · 2.7s of that was before the model was asked',
  '[agent] answered in 9.6s (heard 1.9s, first words at 2.6s, thought through 3.8s) · no tools · 3.9s of that was before the model was asked',
  '[agent] answered in 30.4s (heard 2.7s, first words at 3.0s, thought through 5.9s) · no tools · 3.9s of that was before the model was asked',
  '[agent] answered in 19.0s (heard 0.0s, first words at 3.4s, thought through 5.0s) · no tools · 1.8s of that was before the model was asked',
  '[agent] acted, without saying anything, in 4.1s (heard 1.2s, never spoke, thought through 2.0s) · tools: mcp__bot__move_member',
  '[wake] waited 788ms for someone else to finish talking',
];

function run(input) {
  return spawnSync('bash', [script], { input, encoding: 'utf8' });
}

describe('deploy/latency.sh', () => {
  test('median and p90 of the five spoken answers, silent turns left out', () => {
    const { status, stdout } = run(LINES.join('\n') + '\n');
    assert.equal(status, 0, stdout);
    // Sorted: answered 7.2 9.6 10.4 19.0 30.4 → median 10.4, p90 30.4
    assert.match(stdout, /answered in\s+n=5\s+median\s+10\.4s\s+p90\s+30\.4s/);
    // heard 0.0 1.7 1.9 2.3 2.7
    assert.match(stdout, /heard\s+n=5\s+median\s+1\.9s\s+p90\s+2\.7s/);
    // first words 2.0 2.6 2.7 3.0 3.4
    assert.match(stdout, /first words at\s+n=5\s+median\s+2\.7s\s+p90\s+3\.4s/);
    // thought through 2.7 3.5 3.8 5.0 5.9
    assert.match(stdout, /thought through\s+n=5\s+median\s+3\.8s\s+p90\s+5\.9s/);
  });

  test('per-stage lines add the wait from the last word, when the log has them', () => {
    const lines = [
      ...LINES,
      'mirror-1  | [latency] silence 0.5s · transcript +1.7s · grace +2.6s (0.9s) · settle +2.6s (0.0s) · asked +2.6s · first sentence +4.1s · first audio +4.9s · playing +5.0s · done +9.8s · timeouts none',
      '[latency] silence 0.5s · transcript +1.2s · grace +2.1s (0.9s) · settle +2.1s (0.0s) · asked +2.1s · first sentence +3.5s · first audio +4.2s · playing +4.4s · done +8.0s · timeouts stt=1',
      '[latency] asked +0.0s · first sentence +1.4s · first audio +2.0s · done +6.0s · timeouts none',
    ];
    const { status, stdout } = run(lines.join('\n') + '\n');
    assert.equal(status, 0, stdout);
    // Only the two spoken turns with a `playing` mark count: 4.4 5.0.
    assert.match(stdout, /first audio\s+n=2\s+median\s+5\.0s\s+p90\s+5\.0s/);
    assert.match(stdout, /done\s+n=2\s+median\s+9\.8s\s+p90\s+9\.8s/);
    // The old block is still there for logs that predate the new line.
    assert.match(stdout, /answered in\s+n=5/);
  });

  test('says so when there is nothing to measure', () => {
    const { status, stdout } = run('[app] control panel: http://localhost:3000\n');
    assert.equal(status, 1);
    assert.match(stdout, /no timing lines/);
  });
});
