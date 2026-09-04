import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_INSTRUCTIONS, MAX_INSTRUCTION_CHARS } from '../src/agent/instructions.js';

const SECTION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'web',
  'public',
  'panel',
  'sections',
  'instructions.js',
);

/**
 * The panel's Instructions section cannot import `src/agent/instructions.js`
 * — it's browser code, and that module is server-side — so the two limits
 * are copied by hand there. This is what keeps the copy honest.
 */
describe('the panel Instructions section limits', () => {
  const text = fs.readFileSync(SECTION, 'utf8');

  test('MAX_INSTRUCTIONS matches src/agent/instructions.js', () => {
    const match = text.match(/const MAX_INSTRUCTIONS\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_INSTRUCTIONS not found in the section');
    assert.equal(Number(match[1]), MAX_INSTRUCTIONS);
  });

  test('MAX_INSTRUCTION_CHARS matches src/agent/instructions.js', () => {
    const match = text.match(/const MAX_INSTRUCTION_CHARS\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_INSTRUCTION_CHARS not found in the section');
    assert.equal(Number(match[1]), MAX_INSTRUCTION_CHARS);
  });
});
