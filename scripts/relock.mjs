/**
 * Regenerate package-lock.json describing the whole dependency graph.
 *
 * Run this after changing dependencies, and commit the result. `npm install`
 * alone is not enough, which is not obvious and cost a red CI run to work out:
 *
 * `npm install` resolves for *this* machine. Platform-specific optional
 * packages that this OS and CPU will never use get pruned, and their own
 * dependencies go with them — this project pulls in `@snazzah/davey`, whose
 * wasm32 variant peers on three `@emnapi` packages that no Linux x64 machine
 * ever installs. `npm ci`, on the other hand, validates the *entire* graph
 * including those branches, and refuses to install a lockfile that is missing
 * them. So the file that a normal install leaves behind is exactly the file CI
 * rejects.
 *
 * `--package-lock-only` does not fix it either: npm still reads the existing
 * `node_modules` and keeps the pruned answer. The only way to get a complete
 * resolution is to resolve somewhere there is no `node_modules` at all, which
 * is what this does — copy the manifest to a temp directory, resolve there,
 * copy the lockfile back.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'relock-'));

try {
  fs.copyFileSync(path.join(root, 'package.json'), path.join(scratch, 'package.json'));

  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: scratch,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const generated = path.join(scratch, 'package-lock.json');
  const target = path.join(root, 'package-lock.json');
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const after = fs.readFileSync(generated, 'utf8');

  if (before === after) {
    console.log('package-lock.json is already complete.');
  } else {
    fs.writeFileSync(target, after);
    console.log('package-lock.json regenerated — commit it.');
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
