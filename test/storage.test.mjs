import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
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
    assert.ok(store.revision() > 0);
  } finally {
    if (store?.db.open) store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates a schema version 1 database and rejects a newer schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-migrate-'));
  const dbPath = path.join(root, 'index.sqlite');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      hash TEXT NOT NULL,
      parser TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      line_offsets_json TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE symbols (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER,
      end_column INTEGER,
      signature TEXT,
      exported INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      specifier TEXT NOT NULL,
      imported_name TEXT,
      local_name TEXT,
      resolved_path TEXT,
      is_type_only INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      source_symbol_id TEXT,
      source_symbol_name TEXT,
      target_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      column_no INTEGER
    ) STRICT;
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    ) STRICT;
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, file_path, symbols, text);
    CREATE TABLE edges (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      confidence TEXT NOT NULL,
      file_path TEXT,
      PRIMARY KEY(source_id, target_id, type)
    ) STRICT;
  `);
  legacy.close();

  let store;
  try {
    store = new SqliteStore(dbPath);
    const symbolColumns = store.db.prepare('PRAGMA table_info(symbols)').all().map((column) => column.name);
    const fileColumns = store.db.prepare('PRAGMA table_info(files)').all().map((column) => column.name);
    assert.ok(symbolColumns.includes('role'));
    assert.ok(fileColumns.includes('parser_version'));
    assert.equal(store.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get().value, '2');
    store.replaceFile(documentFor('src/migrated.ts', 'migrated symbol body', ['migratedSymbol']));
    assert.equal(store.findSymbolsByName('migratedSymbol').length, 1);
    store.db.prepare(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`).run();
    store.close();
    assert.throws(() => new SqliteStore(dbPath), /newer local-first-code-index schema/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
