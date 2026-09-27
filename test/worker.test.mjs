import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkerCodeIndex } from '../dist/index.js';

test('worker-thread API indexes and queries without running the engine on the caller thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-worker-'));
  const db = path.join(root, '.index', 'index.sqlite');
  let index;
  try {
    await writeFile(path.join(root, 'main.ts'), `export function workerSearchTarget() { return 42; }\n`);
    index = createWorkerCodeIndex({ workspaceRoot: root, storagePath: db, watch: { enabled: false } });
    const run = await index.start();
    assert.equal(run.indexed, 1);
    const symbols = await index.findSymbol('workerSearchTarget');
    assert.equal(symbols.length, 1);
    const results = await index.search('workerSearchTarget');
    assert.ok(results.some((result) => result.filePath === 'main.ts'));
    const context = await index.getContext({ query: 'workerSearchTarget', maxTokens: 100 });
    assert.ok(context.snippets[0].content.includes('workerSearchTarget'));
    const pack = await index.retrieveContext({ query: 'workerSearchTarget', intent: 'definition' });
    assert.equal(pack.confidence, 'high');
    assert.ok(pack.primary.some((snippet) => snippet.content.includes('workerSearchTarget')));
    assert.equal((await index.getIndexState()).status, 'READY');
    await index.close();
    index = undefined;
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker startup preserves the original storage error for current and future calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-worker-error-'));
  const invalidStoragePath = path.join(root, 'database-directory');
  let index;
  try {
    await mkdir(invalidStoragePath);
    index = createWorkerCodeIndex({
      workspaceRoot: root,
      storagePath: invalidStoragePath,
      watch: { enabled: false },
    });

    await assert.rejects(index.start(), (error) => {
      assert.doesNotMatch(error.message, /exited .*code/i);
      assert.match(error.message, /directory|database|open/i);
      return true;
    });
    await assert.rejects(index.getStats(), (error) => {
      assert.doesNotMatch(error.message, /exited .*code/i);
      assert.match(error.message, /directory|database|open/i);
      return true;
    });
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});
