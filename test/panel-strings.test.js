import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import en from '../src/web/public/panel/strings/en.js';
import es from '../src/web/public/panel/strings/es.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'public');

/**
 * The two languages are one table each; a key in one and not the other is a
 * blank spot on the page for half the readers.
 */
describe('the panel strings', () => {
  test('English and Spanish have the same keys', () => {
    const onlyEn = Object.keys(en).filter((k) => !(k in es));
    const onlyEs = Object.keys(es).filter((k) => !(k in en));
    assert.deepEqual(onlyEn, [], 'keys missing from es.js');
    assert.deepEqual(onlyEs, [], 'keys missing from en.js');
  });

  test('no string is empty', () => {
    for (const [table, name] of [[en, 'en'], [es, 'es']]) {
      for (const [key, value] of Object.entries(table)) {
        assert.ok(typeof value === 'string' && value.length, `${name}: ${key}`);
      }
    }
  });

  test('every key the markup and the sections use exists', () => {
    const files = [path.join(PUBLIC, 'index.html')];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && !full.includes('/strings/')) files.push(full);
      }
    };
    walk(path.join(PUBLIC, 'panel'));

    const used = new Set();
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/data-t(?:-placeholder|-title)?="([^"]+)"/g)) used.add(m[1]);
      for (const m of text.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !(k in en));
    assert.deepEqual(missing, []);
  });
});
