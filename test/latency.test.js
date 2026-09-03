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

  test('says so when there is nothing to measure', () => {
    const { status, stdout } = run('[app] control panel: http://localhost:3000\n');
    assert.equal(status, 1);
    assert.match(stdout, /no timing lines/);
  });
});
