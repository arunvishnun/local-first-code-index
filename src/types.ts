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

export type SymbolRole = 'component' | 'hook';
export type ReferenceKind = 'call' | 'extends' | 'implements' | 'reference';
export type EdgeType = 'contains' | 'imports' | 'calls' | 'extends' | 'implements' | 'references' | 'tests';
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
  role?: SymbolRole;
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
  proximityWeight?: number;
  moduleWeight?: number;
  graphDepth?: number;
  graphSeedLimit?: number;
}

export interface ContextBudget {
  maxFiles: number;
  maxSnippets: number;
  maxLines: number;
  maxBytes: number;
  maxEstimatedTokens: number;
  maxGraphDepth: number;
}

export interface ContextConfig {
  defaultMaxTokens?: number;
  charsPerToken?: number;
  linesBefore?: number;
  linesAfter?: number;
  verifyFreshness?: boolean;
  budget?: Partial<ContextBudget>;
}

export interface NormalizedContextConfig {
  defaultMaxTokens: number;
  charsPerToken: number;
  linesBefore: number;
  linesAfter: number;
  verifyFreshness: boolean;
  budget: ContextBudget;
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
  context: NormalizedContextConfig;
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
  parserVersion?: string;
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
  role?: SymbolRole;
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
  currentFile?: string;
  openFiles?: string[];
  signal?: AbortSignal;
}

export interface FindSymbolOptions {
  limit?: number;
  kind?: SymbolKind;
  role?: SymbolRole;
  pathPrefix?: string;
}

export interface SearchReason {
  source: 'lexical' | 'symbol' | 'path' | 'graph' | 'proximity' | 'fallback';
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

export type IndexStatus = 'NOT_INDEXED' | 'INDEXING' | 'READY' | 'STALE' | 'ERROR';

export type RetrievalIntent = 'definition' | 'usages' | 'callers' | 'callees' | 'tests' | 'implementation' | 'route' | 'general';

export type RetrievalConfidence = 'high' | 'medium' | 'low' | 'none';

export interface IndexWorkspaceOptions {
  signal?: AbortSignal;
}

export interface IndexRunResult {
  discovered: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  ignored: number;
  parseFallbacks: number;
  durationMs: number;
  parseMs: number;
  writeMs: number;
  dbBytes: number;
  peakRssBytes: number;
  indexRevision: number;
}

export interface IncrementalIndexResult {
  changedFiles: number;
  filesReparsed: number;
  relationshipsRecalculated: number;
  elapsedMs: number;
  cacheInvalidations: number;
  indexRevision: number;
}

export interface IndexState {
  status: IndexStatus;
  revision: number;
  lastError?: string;
  lastRun?: IndexRunResult;
  lastIncremental?: IncrementalIndexResult;
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
  cacheHits: number;
  cacheMisses: number;
  cacheInvalidations: number;
  retrievals: number;
  sourceBytesReturned: number;
  estimatedTokensReturned: number;
}

export interface RetrievalMetrics {
  durationMs: number;
  indexQueries: number;
  graphExpansions: number;
  snippetsReturned: number;
  filesRepresented: number;
  sourceLinesReturned: number;
  bytesReturned: number;
  estimatedTokens: number;
  fullFileBytesAvoided: number;
  cacheHit: boolean;
  cacheMiss: boolean;
  indexHit: boolean;
  fallbackSearches: number;
  indexRevision: number;
  indexStatus: IndexStatus;
}

export interface ReferenceHit {
  filePath: string;
  line: number;
  column?: number;
  kind: ReferenceKind;
  targetName: string;
  sourceSymbol?: SymbolRecord;
}

export interface FileOutlineSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  role?: SymbolRole;
  exported: boolean;
  signature?: string;
  range: SourceRange;
}

export interface FileOutline {
  filePath: string;
  language?: string;
  symbols: FileOutlineSymbol[];
}

export interface SnippetRead {
  filePath: string;
  content: string;
  bytesRead: number;
  startLine: number;
  endLine: number;
  language?: string;
}

export interface RetrieveContextRequest {
  query: string;
  currentFile?: string;
  openFiles?: string[];
  budget?: Partial<ContextBudget>;
  intent?: RetrievalIntent;
  signal?: AbortSignal;
}

export interface ContextPackSnippet {
  filePath: string;
  language: string;
  range: SourceRange;
  content: string;
  estimatedTokens: number;
  bytes: number;
  reason: string;
  score: number;
  signals: SearchReason[];
  symbol?: {
    id: string;
    name: string;
    kind: SymbolKind;
    signature?: string;
    exported: boolean;
    role?: SymbolRole;
  };
}

export interface ContextCandidate {
  filePath: string;
  language?: string;
  score: number;
  reason: string;
  symbolName?: string;
  range?: SourceRange;
}

export interface ContextRelationship {
  type: EdgeType;
  confidence: EdgeConfidence;
  from: string;
  to: string;
  direction: 'incoming' | 'outgoing';
}

export interface ContextImport {
  filePath: string;
  specifier: string;
  localName?: string;
  resolvedPath?: string;
}

export interface ContextPack {
  query: string;
  intent: RetrievalIntent;
  confidence: RetrievalConfidence;
  warnings: string[];
  status: IndexStatus;
  primary: ContextPackSnippet[];
  related: ContextPackSnippet[];
  relationships: ContextRelationship[];
  imports: ContextImport[];
  nextCandidates: ContextCandidate[];
  metrics: RetrievalMetrics;
  truncated: boolean;
}

export type CodeIndexEvent =
  | { type: 'index-start'; at: number }
  | { type: 'index-progress'; at: number; completed: number; total: number; filePath: string }
  | { type: 'index-complete'; at: number; result: IndexRunResult }
  | { type: 'file-indexed'; at: number; filePath: string; parser: string }
  | { type: 'file-removed'; at: number; filePath: string }
  | { type: 'watch-error'; at: number; error: string }
  | { type: 'parse-fallback'; at: number; filePath: string; error?: string }
  | { type: 'status'; at: number; status: IndexStatus; error?: string };
