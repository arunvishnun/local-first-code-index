import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore } from '../dist/storage/sqlite-store.js';

function documentFor(filePath, text, symbols = []) {
  return {
    file: {
      path: filePath,
      language: 'typescript',
      sizeBytes: Buffer.byteLength(text),
      mtimeMs: 1,
      hash: `${filePath}:${text}`,
      parser: 'test',
      parseStatus: 'parsed',
      indexedAt: 1,
    },
    lineOffsets: [0],
    symbols: symbols.map((name, index) => ({
      id: `${filePath}:${name}`,
      filePath,
      name,
      kind: 'function',
      startLine: index + 1,
      endLine: index + 1,
      exported: true,
    })),
    imports: [],
    references: [],
    chunks: [{
      id: `${filePath}:chunk`,
      filePath,
      startLine: 1,
      endLine: 1,
      text,
      symbols: symbols.join(' '),
    }],
  };
}

test('supports FTS5 replacement, removal, reset, and persistent reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-storage-'));
  const dbPath = path.join(root, 'index.sqlite');
  let store;
  try {
    store = new SqliteStore(dbPath);
    store.replaceFile(documentFor('src/under_score.ts', 'original searchable phrase', ['under_score', 'underXscore']));
    store.replaceFile(documentFor('src/percent%file.ts', 'literal percent', ['percent%value', 'slash\\value']));
    store.replaceFile(documentFor('src/percentXfile.ts', 'wildcard decoy', ['percentXvalue', 'slashXvalue']));

    assert.equal(store.lexicalSearch('"original"', 10).length, 1);
    assert.deepEqual(store.symbolSearch(['under_score'], 10).map((row) => row.name), ['under_score']);
    assert.deepEqual(store.pathSearch(['under_score'], 10).map((row) => row.filePath), ['src/under_score.ts']);
    assert.deepEqual(store.symbolSearch(['percent%value'], 10).map((row) => row.name), ['percent%value']);
    assert.deepEqual(store.symbolSearch(['slash\\value'], 10).map((row) => row.name), ['slash\\value']);
    assert.deepEqual(store.pathSearch(['percent%file'], 10).map((row) => row.filePath), ['src/percent%file.ts']);

    store.replaceFile(documentFor('src/under_score.ts', 'replacement searchable phrase', ['under_score']));
    assert.equal(store.lexicalSearch('"original"', 10).length, 0);
    assert.equal(store.lexicalSearch('"replacement"', 10).length, 1);

    store.close();
    store = new SqliteStore(dbPath);
    assert.equal(store.lexicalSearch('"replacement"', 10).length, 1);

    assert.equal(store.removeFile('src/under_score.ts'), true);
    assert.equal(store.lexicalSearch('"replacement"', 10).length, 0);

    store.replaceFile(documentFor('src/reset.ts', 'reset target', ['resetTarget']));
    store.clearAll();
    assert.equal(store.count('files'), 0);
    assert.equal(store.count('chunks'), 0);
  } finally {
    if (store?.db.open) store.close();
    await rm(root, { recursive: true, force: true });
  }
});
