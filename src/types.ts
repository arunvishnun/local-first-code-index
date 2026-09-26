export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'enum'
  | 'type'
  | 'variable'
  | 'property'
  | 'constructor'
  | 'module'
  | 'namespace'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'other';

export type ReferenceKind = 'call' | 'extends' | 'implements' | 'reference';
export type EdgeType = 'contains' | 'imports' | 'calls' | 'extends' | 'implements' | 'references';
export type EdgeConfidence = 'exact' | 'resolved' | 'syntactic' | 'heuristic';

export interface SourceRange {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface ParsedSymbol extends SourceRange {
  name: string;
  kind: SymbolKind;
  signature?: string;
  exported?: boolean;
}

export interface ParsedImport {
  specifier: string;
  importedName?: string;
  localName?: string;
  isTypeOnly?: boolean;
}

export interface ParsedReference {
  sourceSymbolName?: string;
  targetName: string;
  kind: ReferenceKind;
  line: number;
  column?: number;
}

export interface ParsedSyntax {
  parser: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  references: ParsedReference[];
  diagnostics?: string[];
}

export interface SyntaxProviderInput {
  filePath: string;
  relativePath: string;
  language: string;
  content: string;
}

export interface SyntaxProvider {
  readonly name: string;
  supports(input: SyntaxProviderInput): boolean | Promise<boolean>;
  parse(input: SyntaxProviderInput): ParsedSyntax | Promise<ParsedSyntax>;
}

export interface Logger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
}

export interface WatchConfig {
  enabled?: boolean;
  debounceMs?: number;
  reconcileIntervalMs?: number;
}

export interface DiscoveryConfig {
  mode?: 'auto' | 'git' | 'filesystem';
  includeGlobs?: string[];
  ignoreGlobs?: string[];
  maxFileBytes?: number;
  binaryProbeBytes?: number;
  followSymlinks?: boolean;
  gitMaxBufferBytes?: number;
}

export interface ChunkConfig {
  lines?: number;
  overlapLines?: number;
}

export interface GraphConfig {
  enabled?: boolean;
  resolveOnIndex?: boolean;
  includeDirectCalls?: boolean;
}

export interface SearchConfig {
  defaultLimit?: number;
  rrfK?: number;
  lexicalWeight?: number;
  symbolWeight?: number;
  pathWeight?: number;
  graphWeight?: number;
  graphDepth?: number;
  graphSeedLimit?: number;
}

export interface ContextConfig {
  defaultMaxTokens?: number;
  charsPerToken?: number;
  linesBefore?: number;
  linesAfter?: number;
  verifyFreshness?: boolean;
}

export interface FallbackSearchConfig {
  enabled?: boolean;
  ripgrepPath?: 'auto' | string | false;
  maxFiles?: number;
  maxBytes?: number;
}

export interface ResourceConfig {
  maxConcurrency?: number;
  yieldEveryFiles?: number;
}

export interface XbergConfig {
  enabled?: boolean;
  languages?: string[];
  fallBackOnError?: boolean;
}

export interface CodeIndexConfig {
  workspaceRoot: string;
  storagePath?: string;
  watch?: WatchConfig;
  discovery?: DiscoveryConfig;
  chunks?: ChunkConfig;
  graph?: GraphConfig;
  search?: SearchConfig;
  context?: ContextConfig;
  fallbackSearch?: FallbackSearchConfig;
  resources?: ResourceConfig;
  xberg?: XbergConfig;
  extensionLanguageMap?: Record<string, string>;
  syntaxProviders?: SyntaxProvider[];
  logger?: Logger;
}

export interface NormalizedCodeIndexConfig {
  workspaceRoot: string;
  storagePath: string;
  watch: Required<WatchConfig>;
  discovery: Required<DiscoveryConfig>;
  chunks: Required<ChunkConfig>;
  graph: Required<GraphConfig>;
  search: Required<SearchConfig>;
  context: Required<ContextConfig>;
  fallbackSearch: Required<FallbackSearchConfig>;
  resources: Required<ResourceConfig>;
  xberg: Required<XbergConfig>;
  extensionLanguageMap: Record<string, string>;
  syntaxProviders: SyntaxProvider[];
  logger: Logger;
}

export interface IndexedFile {
  path: string;
  language: string;
  sizeBytes: number;
  mtimeMs: number;
  hash: string;
  parser: string;
  parseStatus: 'parsed' | 'fallback' | 'failed';
  indexedAt: number;
}

export interface SymbolRecord extends SourceRange {
  id: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  signature?: string;
  exported: boolean;
}

export interface ImportRecord {
  id: number;
  filePath: string;
  specifier: string;
  importedName?: string;
  localName?: string;
  resolvedPath?: string;
  isTypeOnly: boolean;
}

export interface ReferenceRecord {
  id: number;
  filePath: string;
  sourceSymbolId?: string;
  sourceSymbolName?: string;
  targetName: string;
  kind: ReferenceKind;
  line: number;
  column?: number;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: EdgeType;
  confidence: EdgeConfidence;
  filePath?: string;
}

export interface SearchOptions {
  limit?: number;
  expandGraph?: boolean;
  graphDepth?: number;
  languages?: string[];
  pathPrefix?: string;
  fallbackIfEmpty?: boolean;
}

export interface SearchReason {
  source: 'lexical' | 'symbol' | 'path' | 'graph' | 'fallback';
  rank: number;
  contribution: number;
}

export interface SearchResult {
  filePath: string;
  language: string;
  score: number;
  range: SourceRange;
  symbol?: Pick<SymbolRecord, 'id' | 'name' | 'kind' | 'signature'>;
  reasons: SearchReason[];
  snippet?: string;
}

export interface RelatedNode {
  direction: 'incoming' | 'outgoing';
  edge: GraphEdge;
  symbol?: SymbolRecord;
  filePath?: string;
}

export interface ContextRequest {
  query?: string;
  results?: SearchResult[];
  maxTokens?: number;
  linesBefore?: number;
  linesAfter?: number;
  limit?: number;
}

export interface ContextSnippet {
  filePath: string;
  language: string;
  range: SourceRange;
  content: string;
  estimatedTokens: number;
  sourceScore: number;
}

export interface ContextResult {
  snippets: ContextSnippet[];
  estimatedTokens: number;
  bytesRead: number;
  truncated: boolean;
}

export interface IndexRunResult {
  discovered: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  parseFallbacks: number;
  durationMs: number;
}

export interface IndexStats {
  files: number;
  symbols: number;
  imports: number;
  references: number;
  edges: number;
  chunks: number;
  totalBytesIndexed: number;
  queries: number;
  queryLatencyMsTotal: number;
  exactBytesRead: number;
  fallbackSearches: number;
  parseFailures: number;
  genericFallbacks: number;
}

export type CodeIndexEvent =
  | { type: 'index-start'; at: number }
  | { type: 'index-complete'; at: number; result: IndexRunResult }
  | { type: 'file-indexed'; at: number; filePath: string; parser: string }
  | { type: 'file-removed'; at: number; filePath: string }
  | { type: 'watch-error'; at: number; error: string }
  | { type: 'parse-fallback'; at: number; filePath: string; error?: string };
