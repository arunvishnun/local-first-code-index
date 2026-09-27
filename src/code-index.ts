import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { ResultCache } from './cache/result-cache.js';
import { normalizeConfig } from './config.js';
import { buildContextPack } from './context/context-pack.js';
import { discoverFiles, isPathIncluded, readSourceFile } from './discovery.js';
import { rebuildGraph } from './graph.js';
import { detectLanguage } from './language.js';
import { CompositeSyntaxProvider } from './parser/composite.js';
import { SearchService, type SearchTrace } from './search/search-service.js';
import { SqliteStore, type FileIndexDocument, type StoredChunk } from './storage/sqlite-store.js';
import type {
  CodeIndexConfig, CodeIndexEvent, ContextPack, ContextRequest, ContextResult, ContextSnippet, FileOutline,
  FindSymbolOptions, IncrementalIndexResult, IndexRunResult, IndexState, IndexStats, IndexStatus, IndexWorkspaceOptions,
  NormalizedCodeIndexConfig, ReferenceHit, RelatedNode, RetrievalMetrics, RetrieveContextRequest, SearchOptions,
  SearchResult, SnippetRead, SymbolRecord,
} from './types.js';
import { isAbortError, throwIfAborted } from './util/abort.js';
import { sha256, stableId } from './util/hash.js';
import { fileNodeId, normalizeRelativePath } from './util/path.js';
import { computeLineByteOffsets, createLineChunks } from './util/text.js';
import { PARSER_INDEX_VERSION } from './version.js';

interface RuntimeCounters {
  queries: number;
  queryLatencyMsTotal: number;
  exactBytesRead: number;
  fallbackSearches: number;
  parseFailures: number;
  genericFallbacks: number;
  retrievals: number;
  sourceBytesReturned: number;
  estimatedTokensReturned: number;
}

interface IndexTiming {
  parseMs: number;
  writeMs: number;
  peakRssBytes: number;
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
  #status: IndexStatus;
  #lastError?: string;
  #lastRun?: IndexRunResult;
  #lastIncremental?: IncrementalIndexResult;
  #lastRetrieval?: RetrievalMetrics;
  #cacheRevision: number;
  #searchCache = new ResultCache<SearchResult[]>();
  #symbolCache = new ResultCache<SymbolRecord[]>();
  #counters: RuntimeCounters = {
    queries: 0, queryLatencyMsTotal: 0, exactBytesRead: 0, fallbackSearches: 0, parseFailures: 0, genericFallbacks: 0,
    retrievals: 0, sourceBytesReturned: 0, estimatedTokensReturned: 0,
  };

  constructor(config: CodeIndexConfig) {
    super();
    this.config = normalizeConfig(config);
    this.store = new SqliteStore(this.config.storagePath);
    this.parser = new CompositeSyntaxProvider(this.config);
    this.searchService = new SearchService(this.store, this.config);
    this.#cacheRevision = this.store.revision();
    this.#status = this.store.count('files') > 0 ? 'READY' : 'NOT_INDEXED';
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

  async start(options: IndexWorkspaceOptions = {}): Promise<IndexRunResult> {
    this.ensureOpen();
    const result = await this.indexWorkspace(options);
    if (this.config.watch.enabled) this.startWatching();
    return result;
  }

  async indexWorkspace(options: IndexWorkspaceOptions = {}): Promise<IndexRunResult> {
    this.ensureOpen();
    const started = performance.now();
    const timing: IndexTiming = { parseMs: 0, writeMs: 0, peakRssBytes: process.memoryUsage().rss };
    this.setStatus('INDEXING');
    this.emitEvent({ type: 'index-start', at: Date.now() });
    try {
      throwIfAborted(options.signal);
      const discoveredResult = await discoverFiles(this.config, options.signal);
      const discovered = discoveredResult.files;
      const discoveredSet = new Set(discovered);
      const existing = new Map(this.store.listFiles().map((file) => [file.path, file]));
      let indexed = 0;
      let unchanged = 0;
      let skipped = 0;
      let parseFallbacks = 0;
      let completed = 0;
      let cursor = 0;
      let aborted = false;

    const worker = async (): Promise<void> => {
      while (cursor < discovered.length) {
        if (options.signal?.aborted) {
          aborted = true;
          return;
        }
        const current = cursor++;
        const relativePath = discovered[current]!;
        const prior = existing.get(relativePath);
        try {
          const metadata = await stat(path.join(this.config.workspaceRoot, relativePath));
          timing.peakRssBytes = Math.max(timing.peakRssBytes, process.memoryUsage().rss);
          if (
            prior
            && prior.parserVersion === PARSER_INDEX_VERSION
            && prior.sizeBytes === metadata.size
            && Math.trunc(prior.mtimeMs) === Math.trunc(metadata.mtimeMs)
          ) {
            unchanged += 1;
          } else {
            const outcome = await this.indexFileInternal(relativePath, false, timing);
            if (outcome === 'indexed') indexed += 1;
            else if (outcome === 'unchanged') unchanged += 1;
            else if (outcome === 'fallback') { indexed += 1; parseFallbacks += 1; }
            else skipped += 1;
          }
        } catch (error) {
          if (isAbortError(error)) {
            aborted = true;
            return;
          }
          skipped += 1;
          this.config.logger.warn?.('Failed to index file', { relativePath, error: String(error) });
        }
        completed += 1;
        if (completed % this.config.resources.yieldEveryFiles === 0 || completed === discovered.length) {
          this.emitEvent({ type: 'index-progress', at: Date.now(), completed, total: discovered.length, filePath: relativePath });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
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

    if (!aborted && this.config.graph.enabled && this.config.graph.resolveOnIndex) rebuildGraph(this.store, this.config);
    this.touchCache();
    const result: IndexRunResult = {
      discovered: discovered.length, indexed, unchanged, removed, skipped, ignored: discoveredResult.ignored, parseFallbacks,
      durationMs: performance.now() - started,
      parseMs: timing.parseMs,
      writeMs: timing.writeMs,
      dbBytes: this.store.databaseSizeBytes(),
      peakRssBytes: Math.max(timing.peakRssBytes, process.memoryUsage().rss),
      indexRevision: this.store.revision(),
    };
    this.#lastRun = result;
    if (aborted || options.signal?.aborted) {
      this.setStatus(this.store.count('files') > 0 ? 'STALE' : 'NOT_INDEXED');
      throwIfAborted(options.signal);
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    this.setStatus('READY');
    this.emitEvent({ type: 'index-complete', at: Date.now(), result });
    return result;
    } catch (error) {
      if (isAbortError(error)) this.setStatus(this.store.count('files') > 0 ? 'STALE' : 'NOT_INDEXED');
      else this.setStatus('ERROR', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async reconcile(): Promise<IndexRunResult> { return this.indexWorkspace(); }

  async indexFile(filePath: string): Promise<'indexed' | 'unchanged' | 'fallback' | 'skipped'> {
    const started = performance.now();
    const invalidationsBefore = this.cacheInvalidations();
    const timing: IndexTiming = { parseMs: 0, writeMs: 0, peakRssBytes: process.memoryUsage().rss };
    const result = await this.indexFileInternal(filePath, false, timing);
    let relationships = 0;
    if (this.config.graph.enabled && this.config.graph.resolveOnIndex && (result === 'indexed' || result === 'fallback')) {
      rebuildGraph(this.store, this.config);
      relationships = 1;
    }
    if (result === 'indexed' || result === 'fallback') {
      this.touchCache();
      this.#lastIncremental = {
        changedFiles: 1,
        filesReparsed: 1,
        relationshipsRecalculated: relationships,
        elapsedMs: performance.now() - started,
        cacheInvalidations: this.cacheInvalidations() - invalidationsBefore,
        indexRevision: this.store.revision(),
      };
    }
    return result;
  }

  private async indexFileInternal(filePath: string, fromWatcher: boolean, timing?: IndexTiming): Promise<'indexed' | 'unchanged' | 'fallback' | 'skipped'> {
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
    if (previous?.hash === hash && previous.parserVersion === PARSER_INDEX_VERSION) {
      this.store.updateFileMetadata(relativePath, source.sizeBytes, source.mtimeMs, Date.now());
      return 'unchanged';
    }

    const language = detectLanguage(source.absolutePath, source.content.slice(0, 512), this.config);
    const parseStarted = performance.now();
    const parseResult = await this.parser.parse({
      filePath: source.absolutePath,
      relativePath,
      language,
      content: source.content,
    });
    if (timing) timing.parseMs += performance.now() - parseStarted;
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
      ...(symbol.role ? { role: symbol.role } : {}),
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
        parserVersion: PARSER_INDEX_VERSION,
        parseStatus: parseResult.fallback ? 'fallback' : 'parsed',
        indexedAt: Date.now(),
      },
      lineOffsets,
      symbols,
      imports: parseResult.syntax.imports,
      references,
      chunks,
    };
    const writeStarted = performance.now();
    this.store.replaceFile(document);
    if (timing) {
      timing.writeMs += performance.now() - writeStarted;
      timing.peakRssBytes = Math.max(timing.peakRssBytes, process.memoryUsage().rss);
    }
    this.emitEvent({ type: 'file-indexed', at: Date.now(), filePath: relativePath, parser: parseResult.syntax.parser });
    return parseResult.fallback ? 'fallback' : 'indexed';
  }

  removeFile(filePath: string): boolean {
    const relativePath = normalizeRelativePath(path.isAbsolute(filePath) ? path.relative(this.config.workspaceRoot, filePath) : filePath);
    const removed = this.store.removeFile(relativePath);
    if (removed) {
      if (this.config.graph.enabled && this.config.graph.resolveOnIndex) rebuildGraph(this.store, this.config);
      this.touchCache();
      this.emitEvent({ type: 'file-removed', at: Date.now(), filePath: relativePath });
    }
    return removed;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    this.ensureOpen();
    throwIfAborted(options.signal);
    const started = performance.now();
    const revision = this.touchCache();
    const cacheKey = searchCacheKey(query, options);
    const cached = this.#searchCache.get(revision, cacheKey);
    const trace: SearchTrace = { indexQueries: 0, graphExpansions: 0, fallbackSearches: 0, cacheHit: Boolean(cached) };
    const results = cached ?? await this.searchService.search(query, options, trace);
    if (!cached) this.#searchCache.set(revision, cacheKey, results);
    const durationMs = performance.now() - started;
    this.#counters.queries += 1;
    this.#counters.queryLatencyMsTotal += durationMs;
    this.recordRetrieval(this.metricsFromSearch(results, trace, durationMs));
    return results;
  }

  findSymbol(name: string, limitOrOptions: number | FindSymbolOptions = 50): SymbolRecord[] {
    this.ensureOpen();
    const options: FindSymbolOptions = typeof limitOrOptions === 'number' || limitOrOptions == null
      ? { limit: typeof limitOrOptions === 'number' ? limitOrOptions : 50 }
      : limitOrOptions;
    const limit = options.limit ?? 50;
    const revision = this.touchCache();
    const cacheKey = JSON.stringify({ name, limit, kind: options.kind, role: options.role, pathPrefix: options.pathPrefix });
    const cached = this.#symbolCache.get(revision, cacheKey);
    if (cached) return cached;
    const rows = this.store.findSymbolsByName(name, limit, {
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.role ? { role: options.role } : {}),
      ...(options.pathPrefix ? { pathPrefix: normalizeRelativePath(options.pathPrefix) } : {}),
    });
    this.#symbolCache.set(revision, cacheKey, rows);
    return rows;
  }

  findReferences(nameOrId: string, limit = 50): ReferenceHit[] {
    this.ensureOpen();
    const symbol = this.store.getSymbol(nameOrId);
    const name = symbol?.name ?? nameOrId;
    return this.store.referencesByTarget(name, limit).map((reference) => {
      const sourceSymbol = reference.sourceSymbolId ? this.store.getSymbol(reference.sourceSymbolId) : undefined;
      return {
        filePath: reference.filePath,
        line: reference.line,
        ...(reference.column !== undefined ? { column: reference.column } : {}),
        kind: reference.kind,
        targetName: reference.targetName,
        ...(sourceSymbol ? { sourceSymbol } : {}),
      };
    });
  }

  getDefinition(nameOrId: string): SymbolRecord | undefined {
    this.ensureOpen();
    return this.store.getSymbol(nameOrId) ?? this.findSymbol(nameOrId, 1)[0];
  }

  getFileOutline(filePath: string): FileOutline {
    this.ensureOpen();
    const relativePath = normalizeRelativePath(path.isAbsolute(filePath) ? path.relative(this.config.workspaceRoot, filePath) : filePath);
    const file = this.store.getFile(relativePath);
    return {
      filePath: relativePath,
      ...(file ? { language: file.language } : {}),
      symbols: this.store.symbolsInFile(relativePath).map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported,
        ...(symbol.role ? { role: symbol.role } : {}),
        ...(symbol.signature ? { signature: symbol.signature } : {}),
        range: {
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          ...(symbol.startColumn !== undefined ? { startColumn: symbol.startColumn } : {}),
          ...(symbol.endColumn !== undefined ? { endColumn: symbol.endColumn } : {}),
        },
      })),
    };
  }

  async getSnippet(filePath: string, startLine: number, endLine: number): Promise<SnippetRead | undefined> {
    const read = await this.readExactRange(filePath, startLine, endLine);
    if (!read) return undefined;
    const relativePath = normalizeRelativePath(filePath);
    const file = this.store.getFile(relativePath);
    return { filePath: relativePath, ...read, ...(file ? { language: file.language } : {}) };
  }

  async retrieveContext(request: RetrieveContextRequest): Promise<ContextPack> {
    this.ensureOpen();
    const pack = await buildContextPack({
      config: this.config,
      store: this.store,
      search: async (query, options, trace) => {
        throwIfAborted(options.signal);
        const revision = this.touchCache();
        const cacheKey = searchCacheKey(query, options);
        const cached = this.#searchCache.get(revision, cacheKey);
        if (cached) {
          trace.cacheHit = true;
          return cached;
        }
        const results = await this.searchService.search(query, options, trace);
        this.#searchCache.set(revision, cacheKey, results);
        return results;
      },
      readRange: (filePath, startLine, endLine) => this.readExactRange(filePath, startLine, endLine),
      findSymbol: (name) => this.findSymbol(name, 20),
      findReferences: (name) => this.findReferences(name, 40),
      status: () => this.#status,
      revision: () => this.store.revision(),
    }, request);
    this.recordRetrieval(pack.metrics);
    return pack;
  }

  async getRelatedContext(symbol: string, budget?: RetrieveContextRequest['budget']): Promise<ContextPack> {
    return this.retrieveContext({ query: symbol, intent: 'general', ...(budget ? { budget } : {}) });
  }

  getIndexState(): IndexState {
    return {
      status: this.#status,
      revision: this.store.revision(),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      ...(this.#lastRun ? { lastRun: this.#lastRun } : {}),
      ...(this.#lastIncremental ? { lastIncremental: this.#lastIncremental } : {}),
    };
  }

  getLastRetrieval(): RetrievalMetrics | undefined {
    return this.#lastRetrieval;
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
      totalBytesIndexed: this.store.totalBytesIndexed(),
      ...this.#counters,
      cacheHits: this.#searchCache.hits + this.#symbolCache.hits,
      cacheMisses: this.#searchCache.misses + this.#symbolCache.misses,
      cacheInvalidations: this.cacheInvalidations(),
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
        if (this.#status === 'READY') this.setStatus('STALE');
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
    const started = performance.now();
    const invalidationsBefore = this.cacheInvalidations();
    const paths = [...this.#pendingWatchPaths];
    this.#pendingWatchPaths.clear();
    let changed = false;
    let reparsed = 0;
    for (const relative of paths) {
      try {
        await stat(path.join(this.config.workspaceRoot, relative));
        const outcome = await this.indexFileInternal(relative, true);
        if (outcome !== 'unchanged' && outcome !== 'skipped') {
          changed = true;
          reparsed += 1;
        }
      } catch {
        if (this.store.removeFile(relative)) {
          changed = true;
          this.emitEvent({ type: 'file-removed', at: Date.now(), filePath: relative });
        }
      }
    }
    if (changed && this.config.graph.enabled && this.config.graph.resolveOnIndex) rebuildGraph(this.store, this.config);
    if (changed) this.touchCache();
    this.#lastIncremental = {
      changedFiles: paths.length,
      filesReparsed: reparsed,
      relationshipsRecalculated: changed && this.config.graph.enabled && this.config.graph.resolveOnIndex ? 1 : 0,
      elapsedMs: performance.now() - started,
      cacheInvalidations: this.cacheInvalidations() - invalidationsBefore,
      indexRevision: this.store.revision(),
    };
    if (this.#status === 'STALE' || this.#status === 'INDEXING') this.setStatus('READY');
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

  private setStatus(status: IndexStatus, error?: string): void {
    this.#status = status;
    if (error) this.#lastError = error;
    else if (status === 'READY') this.#lastError = undefined;
    this.emitEvent({ type: 'status', at: Date.now(), status, ...(this.#lastError && status === 'ERROR' ? { error: this.#lastError } : {}) });
  }

  private cacheInvalidations(): number {
    return this.#searchCache.invalidations + this.#symbolCache.invalidations;
  }

  private touchCache(): number {
    const revision = this.store.revision();
    if (revision !== this.#cacheRevision) {
      this.#searchCache.invalidate();
      this.#symbolCache.invalidate();
      this.#cacheRevision = revision;
    }
    return revision;
  }

  private recordRetrieval(metrics: RetrievalMetrics): void {
    this.#lastRetrieval = metrics;
    this.#counters.retrievals += 1;
    this.#counters.sourceBytesReturned += metrics.bytesReturned;
    this.#counters.estimatedTokensReturned += metrics.estimatedTokens;
    this.#counters.fallbackSearches += metrics.fallbackSearches;
  }

  private metricsFromSearch(results: SearchResult[], trace: SearchTrace, durationMs: number): RetrievalMetrics {
    const files = new Set(results.map((result) => result.filePath));
    let lines = 0;
    let bytes = 0;
    let avoided = 0;
    const returnedByFile = new Map<string, number>();
    for (const result of results) {
      lines += Math.max(1, result.range.endLine - result.range.startLine + 1);
      const snippetBytes = result.snippet ? Buffer.byteLength(result.snippet) : 0;
      bytes += snippetBytes;
      returnedByFile.set(result.filePath, (returnedByFile.get(result.filePath) ?? 0) + snippetBytes);
    }
    for (const [filePath, returned] of returnedByFile) {
      const file = this.store.getFile(filePath);
      if (file && returned > 0 && file.sizeBytes > returned) avoided += file.sizeBytes - returned;
    }
    const estimatedTokens = Math.ceil(bytes / this.config.context.charsPerToken);
    return {
      durationMs,
      indexQueries: trace.indexQueries,
      graphExpansions: trace.graphExpansions,
      snippetsReturned: results.length,
      filesRepresented: files.size,
      sourceLinesReturned: lines,
      bytesReturned: bytes,
      estimatedTokens,
      fullFileBytesAvoided: avoided,
      cacheHit: trace.cacheHit,
      cacheMiss: !trace.cacheHit,
      indexHit: results.some((result) => result.reasons.every((reason) => reason.source !== 'fallback')),
      fallbackSearches: trace.fallbackSearches,
      indexRevision: this.store.revision(),
      indexStatus: this.#status,
    };
  }
}

function searchCacheKey(query: string, options: SearchOptions): string {
  return JSON.stringify({
    query,
    limit: options.limit ?? null,
    expandGraph: options.expandGraph ?? null,
    graphDepth: options.graphDepth ?? null,
    languages: options.languages ?? null,
    pathPrefix: options.pathPrefix ?? null,
    fallbackIfEmpty: options.fallbackIfEmpty ?? null,
    currentFile: options.currentFile ?? null,
    openFiles: options.openFiles ?? null,
  });
}

export function createCodeIndex(config: CodeIndexConfig): CodeIndex {
  return new CodeIndex(config);
}
