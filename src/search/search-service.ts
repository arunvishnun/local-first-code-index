import path from 'node:path';
import type { NormalizedCodeIndexConfig, SearchOptions, SearchReason, SearchResult, SymbolRecord } from '../types.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { throwIfAborted } from '../util/abort.js';
import { fileNodeId, normalizeRelativePath } from '../util/path.js';
import { queryTokens, toSafeFtsQuery } from '../util/text.js';
import { fallbackSearch } from './fallback.js';

export interface SearchTrace {
  indexQueries: number;
  graphExpansions: number;
  fallbackSearches: number;
  cacheHit: boolean;
}

interface Candidate {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  score: number;
  reasons: SearchReason[];
  symbol?: SymbolRecord;
  snippet?: string;
}

function keyFor(candidate: Pick<Candidate, 'filePath' | 'startLine' | 'endLine'>): string {
  return `${candidate.filePath}:${candidate.startLine}:${candidate.endLine}`;
}

export class SearchService {
  constructor(private readonly store: SqliteStore, private readonly config: NormalizedCodeIndexConfig) {}

  async search(query: string, options: SearchOptions = {}, trace: SearchTrace = { indexQueries: 0, graphExpansions: 0, fallbackSearches: 0, cacheHit: false }): Promise<SearchResult[]> {
    throwIfAborted(options.signal);
    const limit = Math.max(1, options.limit ?? this.config.search.defaultLimit);
    const overfetch = Math.max(limit * 4, 40);
    const rrfK = this.config.search.rrfK;
    const candidates = new Map<string, Candidate>();
    const tokens = queryTokens(query);

    const add = (candidate: Omit<Candidate, 'score' | 'reasons'>, source: SearchReason['source'], rank: number, weight: number): void => {
      const contribution = weight / (rrfK + rank);
      const key = keyFor(candidate);
      const existing = candidates.get(key);
      if (existing) {
        existing.score += contribution;
        existing.reasons.push({ source, rank, contribution });
        if (!existing.snippet && candidate.snippet) existing.snippet = candidate.snippet;
        if (!existing.symbol && candidate.symbol) existing.symbol = candidate.symbol;
      } else {
        candidates.set(key, { ...candidate, score: contribution, reasons: [{ source, rank, contribution }] });
      }
    };

    const fts = toSafeFtsQuery(query);
    if (fts) {
      trace.indexQueries += 1;
      const lexical = this.store.lexicalSearch(fts, overfetch);
      lexical.forEach((row) => add({
        filePath: row.filePath, language: row.language, startLine: row.startLine, endLine: row.endLine, snippet: row.text,
      }, 'lexical', row.rank, this.config.search.lexicalWeight));
    }

    trace.indexQueries += 1;
    const symbols = this.store.symbolSearch(tokens, overfetch);
    symbols.forEach((row) => add({
      filePath: row.filePath, language: row.language, startLine: row.startLine, endLine: row.endLine, symbol: row,
    }, 'symbol', row.rank, this.config.search.symbolWeight));

    trace.indexQueries += 1;
    const paths = this.store.pathSearch(tokens, overfetch);
    for (const row of paths) {
      const file = this.store.getFile(row.filePath);
      const endLine = Math.max(1, Math.min(40, file?.lineOffsets.length ?? 1));
      add({ filePath: row.filePath, language: row.language, startLine: 1, endLine }, 'path', row.rank, this.config.search.pathWeight);
    }

    if (options.expandGraph ?? true) {
      trace.graphExpansions += 1;
      trace.indexQueries += 1;
      const seedSymbols = symbols.slice(0, this.config.search.graphSeedLimit);
      const neighbors = this.store.graphNeighbors(
        seedSymbols.map((symbol) => symbol.id),
        Math.max(0, options.graphDepth ?? this.config.search.graphDepth),
        overfetch,
      );
      for (const neighbor of neighbors) {
        if (neighbor.id.startsWith('file:')) {
          const filePath = neighbor.id.slice('file:'.length);
          const file = this.store.getFile(filePath);
          if (!file) continue;
          add({ filePath, language: file.language, startLine: 1, endLine: Math.max(1, Math.min(40, file.lineOffsets.length)) }, 'graph', neighbor.rank, this.config.search.graphWeight);
        } else {
          const symbol = this.store.getSymbol(neighbor.id);
          if (!symbol) continue;
          const file = this.store.getFile(symbol.filePath);
          if (!file) continue;
          add({
            filePath: symbol.filePath, language: file.language,
            startLine: symbol.startLine, endLine: symbol.endLine, symbol,
          }, 'graph', neighbor.rank, this.config.search.graphWeight);
        }
      }
    }

    const currentFile = options.currentFile ? normalizeRelativePath(options.currentFile) : undefined;
    const openFiles = new Set((options.openFiles ?? []).map((filePath) => normalizeRelativePath(filePath)));
    if (currentFile || openFiles.size > 0) {
      for (const candidate of candidates.values()) {
        if (currentFile && candidate.filePath === currentFile) {
          const contribution = this.config.search.proximityWeight;
          candidate.score += contribution;
          candidate.reasons.push({ source: 'proximity', rank: 1, contribution });
        } else if (openFiles.has(candidate.filePath)) {
          const contribution = this.config.search.proximityWeight * 0.5;
          candidate.score += contribution;
          candidate.reasons.push({ source: 'proximity', rank: 2, contribution });
        } else if (currentFile && path.posix.dirname(candidate.filePath) === path.posix.dirname(currentFile)) {
          const contribution = this.config.search.moduleWeight;
          candidate.score += contribution;
          candidate.reasons.push({ source: 'proximity', rank: 3, contribution });
        }
      }
    }

    throwIfAborted(options.signal);
    let results = [...candidates.values()]
      .filter((candidate) => !options.languages || options.languages.includes(candidate.language))
      .filter((candidate) => !options.pathPrefix || candidate.filePath.startsWith(options.pathPrefix))
      .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
      .slice(0, limit)
      .map<SearchResult>((candidate) => ({
        filePath: candidate.filePath,
        language: candidate.language,
        score: candidate.score,
        range: { startLine: candidate.startLine, endLine: candidate.endLine },
        ...(candidate.symbol ? { symbol: {
          id: candidate.symbol.id, name: candidate.symbol.name, kind: candidate.symbol.kind,
          ...(candidate.symbol.signature ? { signature: candidate.symbol.signature } : {}),
        } } : {}),
        reasons: candidate.reasons,
        ...(candidate.snippet ? { snippet: candidate.snippet } : {}),
      }));

    if (results.length === 0 && this.config.fallbackSearch.enabled && (options.fallbackIfEmpty ?? true)) {
      trace.fallbackSearches += 1;
      trace.indexQueries += 1;
      results = await fallbackSearch(query, this.store, this.config, limit);
      results = results
        .filter((candidate) => !options.languages || options.languages.includes(candidate.language))
        .filter((candidate) => !options.pathPrefix || candidate.filePath.startsWith(options.pathPrefix));
    }
    return results;
  }

  relatedSymbolSeed(name: string): string[] {
    return this.store.findSymbolsByName(name).map((symbol) => symbol.id);
  }

  fileNode(filePath: string): string { return fileNodeId(filePath); }
}
