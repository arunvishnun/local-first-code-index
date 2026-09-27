import type { SearchTrace } from '../search/search-service.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type {
  ContextBudget, ContextCandidate, ContextImport, ContextPack, ContextPackSnippet, ContextRelationship,
  NormalizedCodeIndexConfig, ReferenceHit, RetrievalConfidence, RetrievalIntent, RetrievalMetrics,
  RetrieveContextRequest, SearchOptions, SearchResult, SymbolRecord,
} from '../types.js';
import { throwIfAborted } from '../util/abort.js';
import { normalizeRelativePath } from '../util/path.js';
import { candidateTestPaths } from '../util/relations.js';

export interface ContextPackDependencies {
  config: NormalizedCodeIndexConfig;
  store: SqliteStore;
  search: (query: string, options: SearchOptions, trace: SearchTrace) => Promise<SearchResult[]>;
  readRange: (filePath: string, startLine: number, endLine: number) => Promise<{ content: string; bytesRead: number; startLine: number; endLine: number } | undefined>;
  findSymbol: (name: string) => SymbolRecord[];
  findReferences: (name: string) => ReferenceHit[];
  status: () => RetrievalMetrics['indexStatus'];
  revision: () => number;
}

interface BudgetState {
  files: Set<string>;
  snippets: number;
  lines: number;
  bytes: number;
  tokens: number;
  truncated: boolean;
}

const STOP_WORDS = new Set(['where', 'what', 'which', 'when', 'with', 'from', 'that', 'this', 'into', 'does', 'need', 'files', 'file', 'code', 'logic', 'related', 'defined', 'definition', 'called', 'calls', 'using', 'used']);

export function inferIntent(query: string): RetrievalIntent {
  const text = query.toLowerCase();
  if (/\b(test|tests|spec|specs)\b/.test(text)) return 'tests';
  if (/\b(implementations?|implements)\b/.test(text)) return 'implementation';
  if (/\b(route|handler|endpoint)\b/.test(text)) return 'route';
  if (/\b(what calls|who calls|callers of)\b/.test(text)) return 'callers';
  if (/\b(callees|what does .+ call|invoke[sd]?)\b/.test(text)) return 'callees';
  if (/\b(used|usages?|references|referenced|called)\b/.test(text)) return 'usages';
  if (/\b(where is|defined|definition)\b/.test(text)) return 'definition';
  return 'general';
}

export function primaryIdentifier(query: string): string | undefined {
  const quoted = query.match(/["'`]([A-Za-z_$][\w$]*)["'`]/);
  if (quoted?.[1]) return quoted[1];
  const tokens = query.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const interesting = tokens.filter((token) => !STOP_WORDS.has(token.toLowerCase()));
  const shaped = interesting.filter((token) => /[A-Z_]/.test(token) || /[a-z][A-Z]/.test(token));
  if (shaped.length > 0) return [...shaped].sort((left, right) => right.length - left.length)[0];
  if (interesting.length === 1) return interesting[0];
  return undefined;
}

function narrowLexicalHit(store: SqliteStore, result: SearchResult, query: string): SymbolRecord | undefined {
  const tokens = (query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((token) => !STOP_WORDS.has(token));
  if (tokens.length === 0) return undefined;
  const overlapping = store.symbolsInFile(result.filePath).filter((symbol) => symbol.endLine >= result.range.startLine && symbol.startLine <= result.range.endLine);
  const named = overlapping.filter((symbol) => tokens.some((token) => symbol.name.toLowerCase().includes(token)));
  named.sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine) || left.startLine - right.startLine);
  return named[0];
}

function symbolSummary(symbol: SymbolRecord): NonNullable<ContextPackSnippet['symbol']> {
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    exported: symbol.exported,
    ...(symbol.signature ? { signature: symbol.signature } : {}),
    ...(symbol.role ? { role: symbol.role } : {}),
  };
}

function paddedRange(startLine: number, endLine: number, before: number, after: number, maxLines: number): { startLine: number; endLine: number } {
  let start = Math.max(1, startLine - before);
  let end = endLine + after;
  if (end - start + 1 > maxLines) {
    start = startLine;
    end = Math.min(endLine, startLine + maxLines - 1);
  }
  return { startLine: start, endLine: Math.max(start, end) };
}

export async function buildContextPack(deps: ContextPackDependencies, request: RetrieveContextRequest): Promise<ContextPack> {
  const started = performance.now();
  throwIfAborted(request.signal);
  const budget: ContextBudget = { ...deps.config.context.budget, ...request.budget };
  const intent = request.intent ?? inferIntent(request.query);
  const charsPerToken = deps.config.context.charsPerToken;
  const state: BudgetState = { files: new Set(), snippets: 0, lines: 0, bytes: 0, tokens: 0, truncated: false };
  const primary: ContextPackSnippet[] = [];
  const related: ContextPackSnippet[] = [];
  const nextCandidates: ContextCandidate[] = [];
  const seenRanges = new Set<string>();
  let indexQueries = 0;
  let graphExpansions = 0;
  let fallbackSearches = 0;
  let cacheHit = false;
  const warnings: string[] = [];

  const fits = (filePath: string, lineCount: number, byteCount: number, tokenCount: number): boolean => {
    if (state.snippets >= budget.maxSnippets) return false;
    if (!state.files.has(filePath) && state.files.size >= budget.maxFiles) return false;
    if (state.lines + lineCount > budget.maxLines) return false;
    if (state.bytes + byteCount > budget.maxBytes) return false;
    if (state.tokens + tokenCount > budget.maxEstimatedTokens) return false;
    return true;
  };

  const addSnippet = async (
    bucket: ContextPackSnippet[],
    input: {
      filePath: string;
      language: string;
      startLine: number;
      endLine: number;
      reason: string;
      score: number;
      signals: ContextPackSnippet['signals'];
      symbol?: SymbolRecord;
    },
  ): Promise<boolean> => {
    throwIfAborted(request.signal);
    const range = paddedRange(input.startLine, input.endLine, deps.config.context.linesBefore, deps.config.context.linesAfter, budget.maxLines);
    const key = `${input.filePath}:${range.startLine}:${range.endLine}:${input.reason}`;
    if (seenRanges.has(key)) return false;
    if (state.snippets >= budget.maxSnippets || (!state.files.has(input.filePath) && state.files.size >= budget.maxFiles)) {
      state.truncated = true;
      nextCandidates.push({
        filePath: input.filePath,
        language: input.language,
        score: input.score,
        reason: input.reason,
        ...(input.symbol ? { symbolName: input.symbol.name } : {}),
        range,
      });
      return false;
    }
    const read = await deps.readRange(input.filePath, range.startLine, range.endLine);
    if (!read || !read.content) return false;
    let content = read.content;
    let endLine = read.endLine;
    let lineCount = endLine - read.startLine + 1;
    let byteCount = Buffer.byteLength(content);
    let tokenCount = Math.ceil(content.length / charsPerToken);
    if (!fits(input.filePath, lineCount, byteCount, tokenCount)) {
      const remainingLines = budget.maxLines - state.lines;
      const remainingBytes = budget.maxBytes - state.bytes;
      const remainingTokens = budget.maxEstimatedTokens - state.tokens;
      const maxChars = Math.max(0, Math.min(remainingBytes, remainingTokens * charsPerToken));
      const lines = content.split(/\r?\n/).slice(0, Math.max(0, remainingLines));
      content = lines.join('\n').slice(0, maxChars);
      if (!content) {
        state.truncated = true;
        nextCandidates.push({
          filePath: input.filePath, language: input.language, score: input.score, reason: input.reason,
          ...(input.symbol ? { symbolName: input.symbol.name } : {}), range,
        });
        return false;
      }
      endLine = read.startLine + lines.length - 1;
      lineCount = lines.length;
      byteCount = Buffer.byteLength(content);
      tokenCount = Math.ceil(content.length / charsPerToken);
      state.truncated = true;
    }
    seenRanges.add(key);
    state.files.add(input.filePath);
    state.snippets += 1;
    state.lines += lineCount;
    state.bytes += byteCount;
    state.tokens += tokenCount;
    bucket.push({
      filePath: input.filePath,
      language: input.language,
      range: { startLine: read.startLine, endLine },
      content,
      estimatedTokens: tokenCount,
      bytes: byteCount,
      reason: input.reason,
      score: input.score,
      signals: input.signals,
      ...(input.symbol ? { symbol: symbolSummary(input.symbol) } : {}),
    });
    return true;
  };

  const identifier = primaryIdentifier(request.query);
  indexQueries += 1;
  const symbols = identifier ? deps.findSymbol(identifier) : [];
  const currentFile = request.currentFile ? normalizeRelativePath(request.currentFile) : undefined;
  const rankedSymbols = [...symbols].sort((left, right) => {
    const leftScore = (currentFile && left.filePath === currentFile ? 100 : 0) + (left.exported ? 10 : 0);
    const rightScore = (currentFile && right.filePath === currentFile ? 100 : 0) + (right.exported ? 10 : 0);
    return rightScore - leftScore || left.filePath.localeCompare(right.filePath);
  });

  for (const symbol of rankedSymbols) {
    const file = deps.store.getFile(symbol.filePath);
    indexQueries += 1;
    await addSnippet(primary, {
      filePath: symbol.filePath,
      language: file?.language ?? 'text',
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      reason: 'exact symbol match',
      score: 1,
      signals: [{ source: 'symbol', rank: 1, contribution: 1 }],
      symbol,
    });
  }

  const trace: SearchTrace = { indexQueries: 0, graphExpansions: 0, fallbackSearches: 0, cacheHit: false };
  const results = await deps.search(request.query, {
    limit: Math.max(budget.maxSnippets, 4),
    expandGraph: false,
    graphDepth: budget.maxGraphDepth,
    ...(request.currentFile ? { currentFile: request.currentFile } : {}),
    ...(request.openFiles ? { openFiles: request.openFiles } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  }, trace);
  indexQueries += trace.indexQueries;
  graphExpansions += trace.graphExpansions;
  fallbackSearches += trace.fallbackSearches;
  cacheHit = trace.cacheHit;

  const includeSearchSnippets = rankedSymbols.length === 0 || intent === 'general' || intent === 'route';
  for (const result of results) {
    const alreadyPrimary = primary.some((snippet) => snippet.filePath === result.filePath && snippet.symbol?.name === result.symbol?.name);
    if (!includeSearchSnippets || alreadyPrimary || state.snippets >= budget.maxSnippets) {
      if (includeSearchSnippets && state.snippets >= budget.maxSnippets) state.truncated = true;
      if (!alreadyPrimary) {
        nextCandidates.push({
          filePath: result.filePath,
          language: result.language,
          score: result.score,
          reason: result.reasons.map((reason) => reason.source).join('+') || 'search',
          ...(result.symbol ? { symbolName: result.symbol.name } : {}),
          range: result.range,
        });
      }
      continue;
    }
    const symbol = result.symbol?.id ? deps.store.getSymbol(result.symbol.id) : undefined;
    if (result.symbol?.id) indexQueries += 1;
    const narrowed = symbol ? undefined : narrowLexicalHit(deps.store, result, request.query);
    if (narrowed) indexQueries += 1;
    const added = await addSnippet(primary, {
      filePath: result.filePath,
      language: result.language,
      startLine: symbol?.startLine ?? narrowed?.startLine ?? result.range.startLine,
      endLine: symbol?.endLine ?? narrowed?.endLine ?? result.range.endLine,
      reason: result.reasons.some((reason) => reason.source === 'symbol') ? 'ranked symbol match' : 'lexical match',
      score: result.score,
      signals: result.reasons,
      ...(symbol ? { symbol } : {}),
      ...(narrowed && !symbol ? { symbol: narrowed } : {}),
    });
    if (!added && !nextCandidates.some((candidate) => candidate.filePath === result.filePath && candidate.symbolName === result.symbol?.name)) {
      nextCandidates.push({
        filePath: result.filePath,
        language: result.language,
        score: result.score,
        reason: result.reasons.map((reason) => reason.source).join('+') || 'search',
        ...(result.symbol ? { symbolName: result.symbol.name } : {}),
        range: result.range,
      });
    }
  }

  const relationships: ContextRelationship[] = [];
  const seeds = rankedSymbols.length > 0 ? rankedSymbols.slice(0, 3) : [];
  const shouldExpand = intent !== 'definition' && budget.maxGraphDepth > 0 && seeds.length > 0;
  if (shouldExpand) {
    graphExpansions += 1;
    for (const seed of seeds) {
      if (intent === 'usages' || intent === 'callers' || intent === 'general' || intent === 'implementation') {
        indexQueries += 1;
        const references = deps.findReferences(seed.name).filter((reference) => {
          if (intent === 'callers') return reference.kind === 'call';
          if (intent === 'implementation') return reference.kind === 'implements' || reference.kind === 'extends';
          return true;
        });
        for (const reference of references) {
          if (reference.filePath === seed.filePath && reference.line >= seed.startLine && reference.line <= seed.endLine) continue;
          const file = deps.store.getFile(reference.filePath);
          indexQueries += 1;
          await addSnippet(related, {
            filePath: reference.filePath,
            language: file?.language ?? 'text',
            startLine: reference.line,
            endLine: reference.line,
            reason: `${reference.kind} reference`,
            score: 0.5,
            signals: [{ source: 'graph', rank: 1, contribution: 0.5 }],
            ...(reference.sourceSymbol ? { symbol: reference.sourceSymbol } : {}),
          });
        }
      }
      if (intent === 'callees' || intent === 'route' || intent === 'general') {
        const edges = deps.store.edgesForNode(seed.id).filter((edge) => edge.type === 'calls' && edge.sourceId === seed.id);
        indexQueries += 1;
        for (const edge of edges) {
          const target = deps.store.getSymbol(edge.targetId);
          indexQueries += 1;
          if (!target) continue;
          const file = deps.store.getFile(target.filePath);
          indexQueries += 1;
          relationships.push({ type: edge.type, confidence: edge.confidence, from: seed.name, to: target.name, direction: 'outgoing' });
          await addSnippet(related, {
            filePath: target.filePath,
            language: file?.language ?? 'text',
            startLine: target.startLine,
            endLine: target.endLine,
            reason: 'direct callee',
            score: 0.4,
            signals: [{ source: 'graph', rank: 1, contribution: 0.4 }],
            symbol: target,
          });
        }
      }
    }
  }

  if ((intent === 'tests' || intent === 'general') && seeds.length > 0 && budget.maxGraphDepth > 0) {
    graphExpansions += 1;
    for (const seed of seeds) {
      for (const testPath of candidateTestPaths(seed.filePath)) {
        const file = deps.store.getFile(testPath);
        indexQueries += 1;
        if (!file) continue;
        relationships.push({ type: 'tests', confidence: 'exact', from: seed.filePath, to: testPath, direction: 'outgoing' });
        await addSnippet(related, {
          filePath: testPath,
          language: file.language,
          startLine: 1,
          endLine: Math.min(file.lineOffsets.length || 1, 40),
          reason: 'associated test file',
          score: 0.35,
          signals: [{ source: 'graph', rank: 1, contribution: 0.35 }],
        });
      }
    }
  }

  const imports: ContextImport[] = [];
  const importFiles = [...new Set([...primary, ...related].map((snippet) => snippet.filePath))].slice(0, budget.maxFiles);
  for (const filePath of importFiles) {
    indexQueries += 1;
    for (const item of deps.store.importsForFile(filePath)) {
      imports.push({
        filePath,
        specifier: item.specifier,
        ...(item.localName ? { localName: item.localName } : {}),
        ...(item.resolvedPath ? { resolvedPath: item.resolvedPath } : {}),
      });
    }
  }

  let confidence: RetrievalConfidence = 'none';
  if (rankedSymbols.length > 0) confidence = 'high';
  else if (results.some((result) => result.reasons.some((reason) => reason.source !== 'fallback'))) confidence = 'medium';
  else if (results.length > 0) confidence = 'low';
  if (confidence === 'low') warnings.push('Only a fallback text search matched. Treat the snippets as unverified.');
  if (confidence === 'none') warnings.push('No indexed match.');
  if (deps.status() === 'INDEXING' || deps.status() === 'STALE' || deps.status() === 'NOT_INDEXED') {
    warnings.push(`Index status is ${deps.status()}. Results may be incomplete.`);
  }

  let fullFileBytesAvoided = 0;
  const returnedByFile = new Map<string, number>();
  for (const snippet of [...primary, ...related]) returnedByFile.set(snippet.filePath, (returnedByFile.get(snippet.filePath) ?? 0) + snippet.bytes);
  for (const [filePath, returned] of returnedByFile) {
    const file = deps.store.getFile(filePath);
    indexQueries += 1;
    if (file && file.sizeBytes > returned) fullFileBytesAvoided += file.sizeBytes - returned;
  }

  const metrics: RetrievalMetrics = {
    durationMs: performance.now() - started,
    indexQueries,
    graphExpansions,
    snippetsReturned: primary.length + related.length,
    filesRepresented: state.files.size,
    sourceLinesReturned: state.lines,
    bytesReturned: state.bytes,
    estimatedTokens: state.tokens,
    fullFileBytesAvoided,
    cacheHit,
    cacheMiss: !cacheHit,
    indexHit: rankedSymbols.length > 0 || results.some((result) => result.reasons.every((reason) => reason.source !== 'fallback')),
    fallbackSearches,
    indexRevision: deps.revision(),
    indexStatus: deps.status(),
  };

  return {
    query: request.query,
    intent,
    confidence,
    warnings,
    status: deps.status(),
    primary,
    related,
    relationships: relationships.slice(0, 16),
    imports,
    nextCandidates: nextCandidates.slice(0, 8),
    metrics,
    truncated: state.truncated,
  };
}
