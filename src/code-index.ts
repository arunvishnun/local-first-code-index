import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeConfig } from './config.js';
import { discoverFiles, isPathIncluded, readSourceFile } from './discovery.js';
import { rebuildGraph } from './graph.js';
import { detectLanguage } from './language.js';
import { CompositeSyntaxProvider } from './parser/composite.js';
import { SearchService } from './search/search-service.js';
import { SqliteStore, type FileIndexDocument, type StoredChunk } from './storage/sqlite-store.js';
import type {
  CodeIndexConfig, CodeIndexEvent, ContextRequest, ContextResult, ContextSnippet, IndexRunResult, IndexStats,
  NormalizedCodeIndexConfig, RelatedNode, SearchOptions, SearchResult, SymbolRecord,
} from './types.js';
import { sha256, stableId } from './util/hash.js';
import { fileNodeId, normalizeRelativePath } from './util/path.js';
import { computeLineByteOffsets, createLineChunks } from './util/text.js';

interface RuntimeCounters {
  queries: number;
  queryLatencyMsTotal: number;
  exactBytesRead: number;
  fallbackSearches: number;
  parseFailures: number;
  genericFallbacks: number;
}

export class CodeIndex extends EventEmitter {
  readonly config: NormalizedCodeIndexConfig;
  readonly store: SqliteStore;
  readonly parser: CompositeSyntaxProvider;
  readonly searchService: SearchService;

  #watcher?: FSWatcher;
  #watchTimer?: NodeJS.Timeout;
  #reconcileTimer?: NodeJS.Timeout;
  #pendingWatchPaths = new Set<string>();
  #closed = false;
  #counters: RuntimeCounters = {
    queries: 0, queryLatencyMsTotal: 0, exactBytesRead: 0, fallbackSearches: 0, parseFailures: 0, genericFallbacks: 0,
  };

  constructor(config: CodeIndexConfig) {
    super();
    this.config = normalizeConfig(config);
    this.store = new SqliteStore(this.config.storagePath);
    this.parser = new CompositeSyntaxProvider(this.config);
    this.searchService = new SearchService(this.store, this.config);
  }

  override emit(eventName: 'event', event: CodeIndexEvent): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    return super.emit(eventName, ...args);
  }

  onEvent(listener: (event: CodeIndexEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  private emitEvent(event: CodeIndexEvent): void { this.emit('event', event); }

  async start(): Promise<IndexRunResult> {
    this.ensureOpen();
    const result = await this.indexWorkspace();
    if (this.config.watch.enabled) this.startWatching();
    return result;
  }

  async indexWorkspace(): Promise<IndexRunResult> {
    this.ensureOpen();
    const started = performance.now();
    this.emitEvent({ type: 'index-start', at: Date.now() });
    const discovered = await discoverFiles(this.config);
    const discoveredSet = new Set(discovered);
    const existing = new Map(this.store.listFiles().map((file) => [file.path, file]));
    let indexed = 0;
    let unchanged = 0;
    let skipped = 0;
    let parseFallbacks = 0;
    let completed = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < discovered.length) {
        const current = cursor++;
        const relativePath = discovered[current]!;
        const prior = existing.get(relativePath);
        try {
          const metadata = await stat(path.join(this.config.workspaceRoot, relativePath));
          if (prior && prior.sizeBytes === metadata.size && Math.trunc(prior.mtimeMs) === Math.trunc(metadata.mtimeMs)) {
            unchanged += 1;
          } else {
            const outcome = await this.indexFileInternal(relativePath, false);
            if (outcome === 'indexed') indexed += 1;
            else if (outcome === 'unchanged') unchanged += 1;
            else if (outcome === 'fallback') { indexed += 1; parseFallbacks += 1; }
            else skipped += 1;
          }
        } catch (error) {
          skipped += 1;
          this.config.logger.warn?.('Failed to index file', { relativePath, error: String(error) });
        }
        completed += 1;
        if (completed % this.config.resources.yieldEveryFiles === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    const workers = Array.from({ length: Math.min(this.config.resources.maxConcurrency, Math.max(1, discovered.length)) }, () => worker());
    await Promise.all(workers);

    let removed = 0;
    for (const filePath of existing.keys()) {
      if (!discoveredSet.has(filePath)) {
        if (this.store.removeFile(filePath)) {
          removed += 1;
          this.emitEvent({ type: 'file-removed', at: Date.now(), filePath });
        }
      }
    }

    if (this.config.graph.enabled && this.config.graph.resolveOnIndex) rebuildGraph(this.store, this.config);
    const result: IndexRunResult = {
      discovered: discovered.length, indexed, unchanged, removed, skipped, parseFallbacks,
      durationMs: performance.now() - started,
    };
    this.emitEvent({ type: 'index-complete', at: Date.now(), result });
    return result;
  }

  async reconcile(): Promise<IndexRunResult> { return this.indexWorkspace(); }

  async indexFile(filePath: string): Promise<'indexed' | 'unchanged' | 'fallback' | 'skipped'> {
    const result = await this.indexFileInternal(filePath, false);
    if (this.config.graph.enabled && this.config.graph.resolveOnIndex && result !== 'skipped') rebuildGraph(this.store, this.config);
    return result;
  }

  private async indexFileInternal(filePath: string, fromWatcher: boolean): Promise<'indexed' | 'unchanged' | 'fallback' | 'skipped'> {
    this.ensureOpen();
    const relativePath = normalizeRelativePath(path.isAbsolute(filePath) ? path.relative(this.config.workspaceRoot, filePath) : filePath);
    if (!relativePath || relativePath.startsWith('../') || !isPathIncluded(relativePath, this.config)) return 'skipped';
    const source = await readSourceFile(relativePath, this.config);
    if (!source) {
      if (fromWatcher && this.store.removeFile(relativePath)) this.emitEvent({ type: 'file-removed', at: Date.now(), filePath: relativePath });
      return 'skipped';
    }
    const hash = sha256(source.buffer);
    const previous = this.store.getFile(relativePath);
    if (previous?.hash === hash) {
      this.store.updateFileMetadata(relativePath, source.sizeBytes, source.mtimeMs, Date.now());
      return 'unchanged';
    }

    const language = detectLanguage(source.absolutePath, source.content.slice(0, 512), this.config);
    const parseResult = await this.parser.parse({
      filePath: source.absolutePath,
      relativePath,
      language,
      content: source.content,
    });
    if (parseResult.error) this.#counters.parseFailures += 1;
    if (parseResult.fallback) {
      this.#counters.genericFallbacks += 1;
      this.emitEvent({
        type: 'parse-fallback', at: Date.now(), filePath: relativePath,
        ...(parseResult.error ? { error: parseResult.error.message } : {}),
      });
    }

    const symbols: SymbolRecord[] = parseResult.syntax.symbols.map((symbol) => ({
      id: stableId(relativePath, symbol.kind, symbol.name, symbol.startLine, symbol.startColumn),
      filePath: relativePath,
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      ...(symbol.startColumn !== undefined ? { startColumn: symbol.startColumn } : {}),
      ...(symbol.endColumn !== undefined ? { endColumn: symbol.endColumn } : {}),
      ...(symbol.signature ? { signature: symbol.signature } : {}),
      exported: symbol.exported ?? false,
    }));

    const sourceSymbolIdFor = (sourceSymbolName: string | undefined, line: number): string | undefined => {
      if (!sourceSymbolName) return undefined;
      const matches = symbols.filter((symbol) => symbol.name === sourceSymbolName);
      return matches.find((symbol) => symbol.startLine <= line && symbol.endLine >= line)?.id ?? matches[0]?.id;
    };

    const references = parseResult.syntax.references.map((reference) => ({
      ...reference,
      sourceSymbolId: sourceSymbolIdFor(reference.sourceSymbolName, reference.line),
    }));

    const lineOffsets = computeLineByteOffsets(source.buffer);
    const lineChunks = createLineChunks(source.content, this.config.chunks.lines, this.config.chunks.overlapLines);
    const chunks: StoredChunk[] = lineChunks.map((chunk) => {
      const chunkSymbols = symbols
        .filter((symbol) => symbol.endLine >= chunk.startLine && symbol.startLine <= chunk.endLine)
        .map((symbol) => symbol.name)
        .join(' ');
      return {
        id: stableId(relativePath, chunk.startLine, chunk.endLine, hash),
        filePath: relativePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        symbols: chunkSymbols,
      };
    });

    const document: FileIndexDocument = {
      file: {
        path: relativePath,
        language,
        sizeBytes: source.sizeBytes,
        mtimeMs: source.mtimeMs,
        hash,
        parser: parseResult.syntax.parser,
        parseStatus: parseResult.fallback ? 'fallback' : 'parsed',
        indexedAt: Date.now(),
      },
      lineOffsets,
      symbols,
      imports: parseResult.syntax.imports,
      references,
      chunks,
    };
    this.store.replaceFile(document);
    this.emitEvent({ type: 'file-indexed', at: Date.now(), filePath: relativePath, parser: parseResult.syntax.parser });
    return parseResult.fallback ? 'fallback' : 'indexed';
  }

  removeFile(filePath: string): boolean {
    const relativePath = normalizeRelativePath(path.isAbsolute(filePath) ? path.relative(this.config.workspaceRoot, filePath) : filePath);
    const removed = this.store.removeFile(relativePath);
    if (removed) {
      if (this.config.graph.enabled) rebuildGraph(this.store, this.config);
      this.emitEvent({ type: 'file-removed', at: Date.now(), filePath: relativePath });
    }
    return removed;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    this.ensureOpen();
    const started = performance.now();
    const results = await this.searchService.search(query, options);
    this.#counters.queries += 1;
    this.#counters.queryLatencyMsTotal += performance.now() - started;
    if (results.some((result) => result.reasons.some((reason) => reason.source === 'fallback'))) this.#counters.fallbackSearches += 1;
    return results;
  }

  findSymbol(name: string, limit = 50): SymbolRecord[] {
    this.ensureOpen();
    return this.store.findSymbolsByName(name, limit);
  }

  getRelated(idOrName: string): RelatedNode[] {
    this.ensureOpen();
    const direct = this.store.getSymbol(idOrName);
    const seeds = direct ? [direct] : this.store.findSymbolsByName(idOrName);
    const related: RelatedNode[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      for (const edge of this.store.edgesForNode(seed.id)) {
        const direction = edge.sourceId === seed.id ? 'outgoing' : 'incoming';
        const neighborId = direction === 'outgoing' ? edge.targetId : edge.sourceId;
        const dedupe = `${seed.id}:${direction}:${neighborId}:${edge.type}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        if (neighborId.startsWith('file:')) related.push({ direction, edge, filePath: neighborId.slice('file:'.length) });
        else {
          const symbol = this.store.getSymbol(neighborId);
          related.push(symbol ? { direction, edge, symbol } : { direction, edge });
        }
      }
      const fileEdges = this.store.edgesForNode(fileNodeId(seed.filePath));
      for (const edge of fileEdges.filter((item) => item.type === 'imports')) {
        const direction = edge.sourceId === fileNodeId(seed.filePath) ? 'outgoing' : 'incoming';
        const neighbor = direction === 'outgoing' ? edge.targetId : edge.sourceId;
        const key = `${seed.filePath}:${direction}:${neighbor}:imports`;
        if (seen.has(key)) continue;
        seen.add(key);
        related.push({ direction, edge, filePath: neighbor.startsWith('file:') ? neighbor.slice('file:'.length) : neighbor });
      }
    }
    return related;
  }

  async getContext(request: ContextRequest): Promise<ContextResult> {
    this.ensureOpen();
    const maxTokens = request.maxTokens ?? this.config.context.defaultMaxTokens;
    const charsPerToken = this.config.context.charsPerToken;
    const maxChars = Math.max(1, Math.floor(maxTokens * charsPerToken));
    const linesBefore = request.linesBefore ?? this.config.context.linesBefore;
    const linesAfter = request.linesAfter ?? this.config.context.linesAfter;
    const baseResults = request.results ?? (request.query ? await this.search(request.query, { limit: request.limit ?? 20 }) : []);

    const ranges = baseResults.map((result) => ({
      filePath: result.filePath,
      language: result.language,
      startLine: Math.max(1, result.range.startLine - linesBefore),
      endLine: result.range.endLine + linesAfter,
      score: result.score,
    }));

    const merged: typeof ranges = [];
    for (const candidate of ranges.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)) {
      const last = merged.at(-1);
      if (last && last.filePath === candidate.filePath && candidate.startLine <= last.endLine + 1) {
        last.endLine = Math.max(last.endLine, candidate.endLine);
        last.score = Math.max(last.score, candidate.score);
      } else merged.push({ ...candidate });
    }
    merged.sort((a, b) => b.score - a.score);

    const snippets: ContextSnippet[] = [];
    let usedChars = 0;
    let bytesRead = 0;
    let truncated = false;
    for (const range of merged) {
      if (usedChars >= maxChars) { truncated = true; break; }
      const read = await this.readExactRange(range.filePath, range.startLine, range.endLine);
      if (!read) continue;
      bytesRead += read.bytesRead;
      let content = read.content;
      if (usedChars + content.length > maxChars) {
        content = content.slice(0, maxChars - usedChars);
        truncated = true;
      }
      if (!content) break;
      usedChars += content.length;
      snippets.push({
        filePath: range.filePath,
        language: range.language,
        range: { startLine: read.startLine, endLine: read.endLine },
        content,
        estimatedTokens: Math.ceil(content.length / charsPerToken),
        sourceScore: range.score,
      });
      if (truncated) break;
    }
    return { snippets, estimatedTokens: Math.ceil(usedChars / charsPerToken), bytesRead, truncated };
  }

  async readExactRange(filePath: string, startLine: number, endLine: number): Promise<{ content: string; bytesRead: number; startLine: number; endLine: number } | undefined> {
    const relativePath = normalizeRelativePath(filePath);
    let indexed = this.store.getFile(relativePath);
    if (!indexed) return undefined;
    const absolute = path.join(this.config.workspaceRoot, relativePath);
    if (this.config.context.verifyFreshness) {
      try {
        const metadata = await stat(absolute);
        if (metadata.size !== indexed.sizeBytes || Math.trunc(metadata.mtimeMs) !== Math.trunc(indexed.mtimeMs)) {
          await this.indexFile(relativePath);
          indexed = this.store.getFile(relativePath);
          if (!indexed) return undefined;
        }
      } catch { return undefined; }
    }

    const lineCount = Math.max(1, indexed.lineOffsets.length);
    const safeStartLine = Math.max(1, Math.min(startLine, lineCount));
    const safeEndLine = Math.max(safeStartLine, Math.min(endLine, lineCount));
    const startByte = indexed.lineOffsets[safeStartLine - 1] ?? 0;
    const endByte = indexed.lineOffsets[safeEndLine] ?? indexed.sizeBytes;
    const length = Math.max(0, endByte - startByte);
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, startByte);
      this.#counters.exactBytesRead += bytesRead;
      return { content: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead, startLine: safeStartLine, endLine: safeEndLine };
    } finally {
      await handle.close();
    }
  }

  getStats(): IndexStats {
    return {
      files: this.store.count('files'), symbols: this.store.count('symbols'), imports: this.store.count('imports'),
      references: this.store.count('refs'), edges: this.store.count('edges'), chunks: this.store.count('chunks'),
      totalBytesIndexed: this.store.totalBytesIndexed(), ...this.#counters,
    };
  }

  async reset(): Promise<IndexRunResult> {
    this.store.clearAll();
    return this.indexWorkspace();
  }

  startWatching(): void {
    this.ensureOpen();
    if (this.#watcher) return;
    try {
      this.#watcher = watch(this.config.workspaceRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          this.scheduleReconcile();
          return;
        }
        const relative = normalizeRelativePath(String(filename));
        if (!isPathIncluded(relative, this.config)) return;
        this.#pendingWatchPaths.add(relative);
        if (this.#watchTimer) clearTimeout(this.#watchTimer);
        this.#watchTimer = setTimeout(() => { void this.flushWatchChanges(); }, this.config.watch.debounceMs);
        this.#watchTimer.unref();
      });
      this.#watcher.on('error', (error) => {
        this.emitEvent({ type: 'watch-error', at: Date.now(), error: error.message });
        this.config.logger.warn?.('Recursive watcher failed; periodic reconciliation remains active', { error: error.message });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: 'watch-error', at: Date.now(), error: message });
      this.config.logger.warn?.('Unable to start filesystem watcher; using periodic reconciliation only', { error: message });
    }

    if (this.config.watch.reconcileIntervalMs > 0) {
      this.#reconcileTimer = setInterval(() => { void this.reconcile().catch((error) => this.config.logger.warn?.('Periodic reconciliation failed', { error: String(error) })); }, this.config.watch.reconcileIntervalMs);
      this.#reconcileTimer.unref();
    }
  }

  stopWatching(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#watchTimer = undefined;
    this.#reconcileTimer = undefined;
    this.#pendingWatchPaths.clear();
  }

  private scheduleReconcile(): void {
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = setTimeout(() => { void this.reconcile(); }, this.config.watch.debounceMs);
    this.#watchTimer.unref();
  }

  private async flushWatchChanges(): Promise<void> {
    const paths = [...this.#pendingWatchPaths];
    this.#pendingWatchPaths.clear();
    let changed = false;
    for (const relative of paths) {
      try {
        await stat(path.join(this.config.workspaceRoot, relative));
        const outcome = await this.indexFileInternal(relative, true);
        if (outcome !== 'unchanged' && outcome !== 'skipped') changed = true;
      } catch {
        if (this.store.removeFile(relative)) {
          changed = true;
          this.emitEvent({ type: 'file-removed', at: Date.now(), filePath: relative });
        }
      }
    }
    if (changed && this.config.graph.enabled && this.config.graph.resolveOnIndex) rebuildGraph(this.store, this.config);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.stopWatching();
    this.store.close();
    this.#closed = true;
    this.removeAllListeners();
  }

  private ensureOpen(): void {
    if (this.#closed) throw new Error('CodeIndex is closed');
  }
}

export function createCodeIndex(config: CodeIndexConfig): CodeIndex {
  return new CodeIndex(config);
}
