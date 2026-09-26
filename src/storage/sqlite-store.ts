import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  GraphEdge, ImportRecord, IndexedFile, ParsedImport, ParsedReference, ReferenceRecord, SymbolRecord,
} from '../types.js';

export interface StoredChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  symbols: string;
}

export interface FileIndexDocument {
  file: IndexedFile;
  lineOffsets: number[];
  symbols: SymbolRecord[];
  imports: ParsedImport[];
  references: Array<ParsedReference & { sourceSymbolId?: string }>;
  chunks: StoredChunk[];
}

export interface RankedChunkRow {
  chunkId: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  text: string;
  rank: number;
}

export interface RankedSymbolRow extends SymbolRecord { rank: number; language: string; }
export interface RankedPathRow { filePath: string; language: string; rank: number; }

function asNumber(value: unknown): number { return Number(value ?? 0); }
function asString(value: unknown): string { return String(value ?? ''); }
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export class SqliteStore {
  readonly db: Database.Database;

  constructor(readonly storagePath: string) {
    if (storagePath !== ':memory:') mkdirSync(path.dirname(storagePath), { recursive: true });
    this.db = new Database(storagePath, { timeout: 5000 });
    try {
      this.assertFts5Available();
      this.db.exec('PRAGMA foreign_keys = ON;');
      if (storagePath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
      }
      this.initialize();
    } catch (error) {
      if (this.db.open) this.db.close();
      throw error;
    }
  }

  private assertFts5Available(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE temp.__code_index_fts5_probe USING fts5(content);
        DROP TABLE temp.__code_index_fts5_probe;
      `);
    } catch (cause) {
      try { this.db.exec('DROP TABLE IF EXISTS temp.__code_index_fts5_probe;'); } catch { /* preserve the probe failure */ }
      const error = new Error(
        'local-first-code-index requires SQLite FTS5, but the loaded better-sqlite3 binary does not provide it. '
        + 'In Electron, install an Electron-compatible prebuild or rebuild better-sqlite3 for the application runtime.',
        { cause },
      );
      error.name = 'CodeIndexStorageError';
      Object.assign(error, { code: 'CODE_INDEX_FTS5_UNAVAILABLE' });
      throw error;
    }
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO meta(key, value) VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS files (
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

      CREATE TABLE IF NOT EXISTS symbols (
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
      CREATE INDEX IF NOT EXISTS symbols_file_idx ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        specifier TEXT NOT NULL,
        imported_name TEXT,
        local_name TEXT,
        resolved_path TEXT,
        is_type_only INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS imports_file_idx ON imports(file_path);

      CREATE TABLE IF NOT EXISTS refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        source_symbol_id TEXT,
        source_symbol_name TEXT,
        target_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        column_no INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS refs_file_idx ON refs(file_path);
      CREATE INDEX IF NOT EXISTS refs_target_idx ON refs(target_name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chunks_file_idx ON chunks(file_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        file_path,
        symbols,
        text,
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        confidence TEXT NOT NULL,
        file_path TEXT,
        PRIMARY KEY(source_id, target_id, type)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_id);
      CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_id);
    `);
  }

  close(): void { this.db.close(); }

  clearAll(): void {
    this.db.exec('BEGIN;');
    try {
      this.db.exec('DELETE FROM chunks_fts; DELETE FROM edges; DELETE FROM files;');
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }


  getFile(filePath: string): (IndexedFile & { lineOffsets: number[] }) | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      path: asString(row.path), language: asString(row.language), sizeBytes: asNumber(row.size_bytes),
      mtimeMs: asNumber(row.mtime_ms), hash: asString(row.hash), parser: asString(row.parser),
      parseStatus: asString(row.parse_status) as IndexedFile['parseStatus'], indexedAt: asNumber(row.indexed_at),
      lineOffsets: JSON.parse(asString(row.line_offsets_json)) as number[],
    };
  }

  updateFileMetadata(filePath: string, sizeBytes: number, mtimeMs: number, indexedAt: number): void {
    this.db.prepare('UPDATE files SET size_bytes = ?, mtime_ms = ?, indexed_at = ? WHERE path = ?').run(sizeBytes, mtimeMs, indexedAt, filePath);
  }

  listFiles(): IndexedFile[] {
    const rows = this.db.prepare('SELECT path, language, size_bytes, mtime_ms, hash, parser, parse_status, indexed_at FROM files ORDER BY path').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      path: asString(row.path), language: asString(row.language), sizeBytes: asNumber(row.size_bytes),
      mtimeMs: asNumber(row.mtime_ms), hash: asString(row.hash), parser: asString(row.parser),
      parseStatus: asString(row.parse_status) as IndexedFile['parseStatus'], indexedAt: asNumber(row.indexed_at),
    }));
  }

  replaceFile(document: FileIndexDocument): void {
    const { file, lineOffsets, symbols, imports, references, chunks } = document;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM chunks_fts WHERE file_path = ?').run(file.path);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(file.path);
      this.db.prepare(`
        INSERT INTO files(path, language, size_bytes, mtime_ms, hash, parser, parse_status, line_offsets_json, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(file.path, file.language, file.sizeBytes, file.mtimeMs, file.hash, file.parser, file.parseStatus, JSON.stringify(lineOffsets), file.indexedAt);

      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols(id, file_path, name, kind, start_line, end_line, start_column, end_column, signature, exported)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const symbol of symbols) insertSymbol.run(
        symbol.id, symbol.filePath, symbol.name, symbol.kind, symbol.startLine, symbol.endLine,
        symbol.startColumn ?? null, symbol.endColumn ?? null, symbol.signature ?? null, symbol.exported ? 1 : 0,
      );

      const insertImport = this.db.prepare(`
        INSERT INTO imports(file_path, specifier, imported_name, local_name, is_type_only)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const item of imports) insertImport.run(file.path, item.specifier, item.importedName ?? null, item.localName ?? null, item.isTypeOnly ? 1 : 0);

      const insertRef = this.db.prepare(`
        INSERT INTO refs(file_path, source_symbol_id, source_symbol_name, target_name, kind, line, column_no)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of references) insertRef.run(
        file.path, item.sourceSymbolId ?? null, item.sourceSymbolName ?? null, item.targetName, item.kind, item.line, item.column ?? null,
      );

      const insertChunk = this.db.prepare('INSERT INTO chunks(id, file_path, start_line, end_line) VALUES (?, ?, ?, ?)');
      const insertFts = this.db.prepare('INSERT INTO chunks_fts(chunk_id, file_path, symbols, text) VALUES (?, ?, ?, ?)');
      for (const chunk of chunks) {
        insertChunk.run(chunk.id, chunk.filePath, chunk.startLine, chunk.endLine);
        insertFts.run(chunk.id, chunk.filePath, chunk.symbols, chunk.text);
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  removeFile(filePath: string): boolean {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM chunks_fts WHERE file_path = ?').run(filePath);
      const result = this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
      this.db.prepare('DELETE FROM edges WHERE file_path = ? OR source_id = ? OR target_id = ?').run(filePath, `file:${filePath}`, `file:${filePath}`);
      this.db.exec('COMMIT;');
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  lexicalSearch(ftsQuery: string, limit: number): RankedChunkRow[] {
    const rows = this.db.prepare(`
      SELECT f.chunk_id, f.file_path, files.language, c.start_line, c.end_line, f.text,
             bm25(chunks_fts, 0.0, 2.5, 1.0, 1.0) AS bm25_score
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN files ON files.path = f.file_path
      WHERE chunks_fts MATCH ?
      ORDER BY bm25_score ASC
      LIMIT ?
    `).all(ftsQuery, limit) as Record<string, unknown>[];
    return rows.map((row, index) => ({
      chunkId: asString(row.chunk_id), filePath: asString(row.file_path), language: asString(row.language),
      startLine: asNumber(row.start_line), endLine: asNumber(row.end_line), text: asString(row.text), rank: index + 1,
    }));
  }

  symbolSearch(tokens: string[], limit: number): RankedSymbolRow[] {
    if (tokens.length === 0) return [];
    const conditions = tokens.flatMap(() => ['lower(s.name) = lower(?)', "lower(s.name) LIKE lower(?) ESCAPE '\\'"]).join(' OR ');
    const params = tokens.flatMap((token) => [token, `%${escapeLike(token)}%`]);
    const rows = this.db.prepare(`
      SELECT s.*, f.language,
        CASE WHEN ${tokens.map(() => 'lower(s.name) = lower(?)').join(' OR ')} THEN 0 ELSE 1 END AS exact_rank
      FROM symbols s JOIN files f ON f.path = s.file_path
      WHERE ${conditions}
      ORDER BY exact_rank ASC, length(s.name) ASC, s.name ASC
      LIMIT ?
    `).all(...tokens, ...params, limit) as Record<string, unknown>[];
    return rows.map((row, index) => ({ ...this.rowToSymbol(row), language: asString(row.language), rank: index + 1 }));
  }

  pathSearch(tokens: string[], limit: number): RankedPathRow[] {
    if (tokens.length === 0) return [];
    const conditions = tokens.map(() => "lower(path) LIKE lower(?) ESCAPE '\\'").join(' OR ');
    const rows = this.db.prepare(`SELECT path, language FROM files WHERE ${conditions} ORDER BY length(path), path LIMIT ?`)
      .all(...tokens.map((token) => `%${escapeLike(token)}%`), limit) as Record<string, unknown>[];
    return rows.map((row, index) => ({ filePath: asString(row.path), language: asString(row.language), rank: index + 1 }));
  }

  symbolsInFile(filePath: string): SymbolRecord[] {
    const rows = this.db.prepare('SELECT * FROM symbols WHERE file_path = ? ORDER BY start_line, end_line').all(filePath) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSymbol(row));
  }

  getSymbol(id: string): SymbolRecord | undefined {
    const row = this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSymbol(row) : undefined;
  }

  findSymbolsByName(name: string, limit = 50): SymbolRecord[] {
    const rows = this.db.prepare('SELECT * FROM symbols WHERE lower(name) = lower(?) ORDER BY file_path, start_line LIMIT ?').all(name, limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSymbol(row));
  }

  allSymbols(): SymbolRecord[] {
    return (this.db.prepare('SELECT * FROM symbols').all() as Record<string, unknown>[]).map((row) => this.rowToSymbol(row));
  }

  allImports(): ImportRecord[] {
    const rows = this.db.prepare('SELECT * FROM imports').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asNumber(row.id), filePath: asString(row.file_path), specifier: asString(row.specifier),
      importedName: row.imported_name == null ? undefined : asString(row.imported_name),
      localName: row.local_name == null ? undefined : asString(row.local_name),
      resolvedPath: row.resolved_path == null ? undefined : asString(row.resolved_path),
      isTypeOnly: asNumber(row.is_type_only) === 1,
    }));
  }

  allReferences(): ReferenceRecord[] {
    const rows = this.db.prepare('SELECT * FROM refs').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asNumber(row.id), filePath: asString(row.file_path),
      sourceSymbolId: row.source_symbol_id == null ? undefined : asString(row.source_symbol_id),
      sourceSymbolName: row.source_symbol_name == null ? undefined : asString(row.source_symbol_name),
      targetName: asString(row.target_name), kind: asString(row.kind) as ReferenceRecord['kind'],
      line: asNumber(row.line), column: row.column_no == null ? undefined : asNumber(row.column_no),
    }));
  }

  updateResolvedImports(updates: Array<{ id: number; resolvedPath?: string }>): void {
    const stmt = this.db.prepare('UPDATE imports SET resolved_path = ? WHERE id = ?');
    this.db.exec('BEGIN;');
    try {
      for (const update of updates) stmt.run(update.resolvedPath ?? null, update.id);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  replaceEdges(edges: GraphEdge[]): void {
    this.db.exec('BEGIN;');
    try {
      this.db.exec('DELETE FROM edges;');
      const stmt = this.db.prepare('INSERT OR IGNORE INTO edges(source_id, target_id, type, confidence, file_path) VALUES (?, ?, ?, ?, ?)');
      for (const edge of edges) stmt.run(edge.sourceId, edge.targetId, edge.type, edge.confidence, edge.filePath ?? null);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  edgesForNode(id: string): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE source_id = ? OR target_id = ?').all(id, id) as Record<string, unknown>[];
    return rows.map((row) => ({
      sourceId: asString(row.source_id), targetId: asString(row.target_id),
      type: asString(row.type) as GraphEdge['type'], confidence: asString(row.confidence) as GraphEdge['confidence'],
      filePath: row.file_path == null ? undefined : asString(row.file_path),
    }));
  }

  graphNeighbors(seedIds: string[], depth: number, limit: number): Array<{ id: string; rank: number }> {
    if (seedIds.length === 0 || depth <= 0) return [];
    const seen = new Set(seedIds);
    let frontier = [...seedIds];
    const result: Array<{ id: string; rank: number }> = [];
    let rank = 1;
    for (let level = 0; level < depth && frontier.length > 0; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of this.edgesForNode(id)) {
          const neighbor = edge.sourceId === id ? edge.targetId : edge.sourceId;
          if (seen.has(neighbor)) continue;
          seen.add(neighbor);
          result.push({ id: neighbor, rank: rank++ });
          next.push(neighbor);
          if (result.length >= limit) return result;
        }
      }
      frontier = next;
    }
    return result;
  }

  count(table: 'files' | 'symbols' | 'imports' | 'refs' | 'edges' | 'chunks'): number {
    const row = this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as Record<string, unknown>;
    return asNumber(row.count);
  }

  totalBytesIndexed(): number {
    const row = this.db.prepare('SELECT coalesce(sum(size_bytes), 0) AS total FROM files').get() as Record<string, unknown>;
    return asNumber(row.total);
  }

  private rowToSymbol(row: Record<string, unknown>): SymbolRecord {
    return {
      id: asString(row.id), filePath: asString(row.file_path), name: asString(row.name), kind: asString(row.kind) as SymbolRecord['kind'],
      startLine: asNumber(row.start_line), endLine: asNumber(row.end_line),
      startColumn: row.start_column == null ? undefined : asNumber(row.start_column),
      endColumn: row.end_column == null ? undefined : asNumber(row.end_column),
      signature: row.signature == null ? undefined : asString(row.signature), exported: asNumber(row.exported) === 1,
    };
  }
}
