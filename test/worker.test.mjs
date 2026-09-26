import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await index.close();
    index = undefined;
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});
