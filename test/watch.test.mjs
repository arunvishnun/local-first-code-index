import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodeIndex } from '../dist/index.js';

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('watch mode incrementally updates a changed source file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-watch-'));
  const source = path.join(root, 'watched.ts');
  let index;
  try {
    await writeFile(source, `export function beforeWatch() { return 1; }\n`);
    index = createCodeIndex({
      workspaceRoot: root,
      storagePath: path.join(root, '.local-code-index', 'index.sqlite'),
      watch: { enabled: true, debounceMs: 40, reconcileIntervalMs: 0 },
    });
    await index.start();
    assert.equal(index.findSymbol('beforeWatch').length, 1);
    await writeFile(source, `export function afterWatch() { return 2; }\n`);
    const updated = await waitFor(() => index.findSymbol('afterWatch').length === 1);
    assert.equal(updated, true);
    assert.equal(index.findSymbol('beforeWatch').length, 0);
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});
