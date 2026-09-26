import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodeIndex } from '../dist/index.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(path.join(root, 'src', 'helper.ts'), `
export function refreshTree(path: string): string {
  return 'refreshed:' + path;
}

export class TreeStore {
  load() { return refreshTree('root'); }
}
`.trimStart());
  await writeFile(path.join(root, 'src', 'app.ts'), `
import { refreshTree } from './helper';

export function runApp() {
  return refreshTree('workspace');
}
`.trimStart());
  await writeFile(path.join(root, 'tool.py'), `
def calculate_metrics(items):
    return len(items)

# semantic repository navigation helper
`.trimStart());
  await writeFile(path.join(root, 'README.md'), `# Demo\n\nThe file explorer refresh logic should stay local and deterministic.\n`);
  await writeFile(path.join(root, 'node_modules', 'ignored', 'bad.ts'), `export const SHOULD_NOT_INDEX = true;`);
  return root;
}

test('indexes, searches, resolves graph, reads context, updates incrementally and persists', async () => {
  const root = await fixture();
  const db = path.join(root, '.test-index', 'index.sqlite');
  let index;
  try {
    index = createCodeIndex({
      workspaceRoot: root,
      storagePath: db,
      watch: { enabled: false },
      fallbackSearch: { ripgrepPath: false },
    });
    const run = await index.start();
    assert.ok(run.discovered >= 4);
    assert.equal(index.findSymbol('SHOULD_NOT_INDEX').length, 0);

    const refresh = index.findSymbol('refreshTree');
    assert.equal(refresh.length, 1);
    assert.equal(refresh[0].filePath, 'src/helper.ts');

    const results = await index.search('file explorer refresh logic', { limit: 5 });
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.filePath === 'README.md' || r.filePath === 'src/helper.ts'));

    const python = await index.search('semantic repository navigation helper', { limit: 5 });
    assert.ok(python.some((r) => r.filePath === 'tool.py'));

    const related = index.getRelated('refreshTree');
    assert.ok(related.some((item) => item.edge.type === 'calls' || item.edge.type === 'imports'));

    const context = await index.getContext({ query: 'refreshTree', maxTokens: 300 });
    assert.ok(context.snippets.length > 0);
    assert.ok(context.snippets.some((snippet) => snippet.content.includes('refreshTree')));
    assert.ok(context.bytesRead > 0);

    await writeFile(path.join(root, 'src', 'helper.ts'), `
export function rebuildNavigation(path: string): string {
  return 'rebuilt:' + path;
}
`.trimStart());
    const updated = await index.indexFile('src/helper.ts');
    assert.ok(updated === 'indexed' || updated === 'fallback');
    assert.equal(index.findSymbol('refreshTree').length, 0);
    assert.equal(index.findSymbol('rebuildNavigation').length, 1);

    const stats = index.getStats();
    assert.ok(stats.files >= 4);
    assert.ok(stats.chunks >= 4);
    assert.ok(stats.queries >= 3);

    await index.close();
    index = undefined;

    const reopened = createCodeIndex({ workspaceRoot: root, storagePath: db });
    assert.equal(reopened.findSymbol('rebuildNavigation').length, 1);
    await reopened.close();
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});
