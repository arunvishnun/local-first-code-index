# local-first-code-index

A TypeScript/Node package for **local-first repository indexing and deterministic retrieval** in desktop AI agents.

The package is designed to reduce exploratory LLM/tool work by resolving repository context locally first: file discovery → incremental indexing → lexical/symbol/path/graph retrieval → exact source-range reads → selected context for the agent.

## What works in this package now

- Persistent local SQLite/FTS5 index using `better-sqlite3`.
- File metadata, content hashes, line byte offsets and incremental updates.
- Git-aware file discovery (`git ls-files -co --exclude-standard`) with filesystem fallback.
- Configurable include/ignore globs, file-size limits and binary detection.
- TypeScript/JavaScript/TSX/JSX symbol, import, inheritance and direct-call extraction using the TypeScript compiler API.
- Generic text indexing for **every non-binary text file**, even when no language parser exists.
- Optional Xberg Tree-sitter language-pack adapter for broader structured parsing.
- FTS5 lexical retrieval + symbol lookup + path lookup + graph expansion.
- Weighted reciprocal-rank fusion (RRF) across retrieval signals.
- Exact local byte-range reads based on persisted line offsets.
- Context token/character budgets and overlap merging.
- Import graph resolution for relative modules and TypeScript `tsconfig` module/path aliases where resolution lands in the indexed workspace.
- Direct-call graph edges when a target can be resolved without guessing.
- File watching with debounce plus periodic reconciliation.
- Ripgrep fallback when `rg` is available, with a bounded Node fallback when it is not.
- Worker-thread facade so indexing/search does not need to execute on the Electron main/UI thread.
- Telemetry for files/symbols/chunks/edges, query time, exact bytes read, parse fallbacks and fallback searches.

## Runtime requirement

Node **22.13+**.

The package uses `better-sqlite3` because official Node 22 builds do not enable the FTS5 module in `node:sqlite`. FTS5 is a required retrieval capability; the package fails during construction with an actionable error if the loaded SQLite binary does not provide it.

For a desktop app, run the package from the Electron main process, an Electron utility process, or use the provided `WorkerCodeIndex`. Do not run repository indexing in a sandboxed renderer.

## Install

```bash
npm install local-first-code-index
```

The Xberg dependency is optional. The core package does not need Xberg to index/search arbitrary text files.

`better-sqlite3` is a native dependency. Normal Node installations use its compatible prebuilt binary when one is available. Electron applications must package a binary built for their Electron runtime and target architecture. Electron Forge handles native dependencies in its standard packaging flow; other applications can use [`@electron/rebuild`](https://github.com/electron/rebuild).

Do not add an Electron rebuild step to this library or rebuild against system Node and then copy that binary into Electron. The consuming application owns its Electron version and ABI.

## Recommended Electron usage

```ts
import path from 'node:path';
import { app } from 'electron';
import { createWorkerCodeIndex } from 'local-first-code-index';

const index = createWorkerCodeIndex({
  workspaceRoot: '/path/to/repository',
  storagePath: path.join(app.getPath('userData'), 'indexes', 'repo-id', 'index.sqlite'),
  watch: {
    enabled: true,
    debounceMs: 150,
    reconcileIntervalMs: 300_000,
  },
  resources: {
    maxConcurrency: 2,
  },
});

await index.start();

const results = await index.search('where is the file tree refreshed?', {
  limit: 12,
  expandGraph: true,
});

const context = await index.getContext({
  results,
  maxTokens: 6_000,
});

// Send only context.snippets to the LLM, not the repository.
```

See [`examples/electron-main.ts`](./examples/electron-main.ts) for a fuller example.

## Direct API

Use `CodeIndex` directly if you are already running inside your own worker/utility process or you need a custom syntax provider.

```ts
import { createCodeIndex } from 'local-first-code-index';

const index = createCodeIndex({
  workspaceRoot: '/repo',
  storagePath: '/app-data/repo-123/index.sqlite',
});

await index.start();

const symbols = index.findSymbol('refreshTree');
const related = index.getRelated('refreshTree');
const results = await index.search('refresh file explorer');
const context = await index.getContext({ results, maxTokens: 4000 });

await index.close();
```

If Electron reports that `better_sqlite3.node` was compiled for a different `NODE_MODULE_VERSION`, rebuild it from the consuming application:

```bash
npx electron-rebuild -f -w better-sqlite3
```

Use the application's locally installed `@electron/rebuild` and verify both unpackaged development and packaged application startup on every shipping platform.

## Public operations

### Lifecycle

- `start()` — initial reconciliation and optional watcher start.
- `indexWorkspace()` / `reconcile()` — discover current files, index changed files, remove missing files and rebuild deterministic graph edges.
- `indexFile(path)` — update one file.
- `removeFile(path)` — remove one file and its derived data.
- `reset()` — clear and rebuild the index.
- `close()` — stop watchers and close SQLite.

### Retrieval

- `search(query, options)` — fused lexical/symbol/path/graph retrieval.
- `findSymbol(name)` — exact case-insensitive symbol lookup.
- `getRelated(symbolIdOrName)` — incoming/outgoing graph relationships.
- `getContext(...)` — exact-range local reads under a context budget.
- `readExactRange(file, startLine, endLine)` — direct byte-bounded source read (direct `CodeIndex` API).
- `getStats()` — operational counters.

## Language behavior

The package never rejects a normal text file just because there is no parser.

| Capability | Any text language | JS/TS family | Xberg-supported language when enabled |
|---|---:|---:|---:|
| File/path index | ✅ | ✅ | ✅ |
| FTS5 lexical search | ✅ | ✅ | ✅ |
| Exact source-range reads | ✅ | ✅ | ✅ |
| Chunk retrieval | ✅ | ✅ | ✅ |
| Symbols | text only | ✅ | ✅ where Xberg extractor supports it |
| Imports | text only | ✅ | ✅ where Xberg extractor supports it |
| Inheritance/direct calls | text only | ✅ deterministic subset | depends on provider data |
| Compiler-grade references | ❌ | partial | ❌ by default |

The package deliberately does **not** claim a perfect compiler-grade call/reference graph for hundreds of languages.

## Xberg / Tree-sitter language pack

Xberg is **off by default** because its grammar model downloads parsers on first use and caches them locally. That is a different product/network policy than the package's no-network baseline.

Enable it explicitly:

```ts
const index = createCodeIndex({
  workspaceRoot,
  storagePath,
  xberg: {
    enabled: true,
    languages: ['python', 'java', 'go', 'rust'],
    fallBackOnError: true,
  },
});
```

Provider order is:

1. caller-supplied custom providers,
2. TypeScript compiler provider for JS/TS,
3. Xberg provider (when enabled),
4. generic text fallback.

That means JS/TS keeps its stronger deterministic call/import handling instead of being replaced by a generic Tree-sitter result.

For a strict offline desktop product, pre-fetch and package the exact grammars you approve, or leave Xberg disabled. A parser failure never prevents text indexing when `fallBackOnError` is `true`.

## Configuration

```ts
createCodeIndex({
  workspaceRoot: '/repo',                 // required
  storagePath: '/app-data/index.sqlite',  // recommended outside repo

  watch: {
    enabled: false,
    debounceMs: 150,
    reconcileIntervalMs: 300_000,
  },

  discovery: {
    mode: 'auto', // auto | git | filesystem
    includeGlobs: ['**/*'],
    ignoreGlobs: ['**/generated/**'],
    maxFileBytes: 2 * 1024 * 1024,
    binaryProbeBytes: 8192,
    followSymlinks: false,
    gitMaxBufferBytes: 64 * 1024 * 1024,
  },

  chunks: {
    lines: 80,
    overlapLines: 10,
  },

  graph: {
    enabled: true,
    resolveOnIndex: true,
    includeDirectCalls: true,
  },

  search: {
    defaultLimit: 20,
    rrfK: 60,
    lexicalWeight: 1.0,
    symbolWeight: 1.4,
    pathWeight: 0.8,
    graphWeight: 0.7,
    graphDepth: 1,
    graphSeedLimit: 6,
  },

  context: {
    defaultMaxTokens: 6000,
    charsPerToken: 4,
    linesBefore: 3,
    linesAfter: 3,
    verifyFreshness: true,
  },

  fallbackSearch: {
    enabled: true,
    ripgrepPath: 'auto', // 'auto' | absolute path | false
    maxFiles: 500,
    maxBytes: 8 * 1024 * 1024,
  },

  resources: {
    maxConcurrency: 2,
    yieldEveryFiles: 10,
  },

  xberg: {
    enabled: false,
    languages: [],
    fallBackOnError: true,
  },
});
```

### Custom syntax providers

You can add a provider without changing the core package:

```ts
import type { SyntaxProvider } from 'local-first-code-index';

const myProvider: SyntaxProvider = {
  name: 'company-language-parser',
  supports: ({ language }) => language === 'my-language',
  parse: ({ content }) => ({
    parser: 'company-language-parser',
    symbols: [],
    imports: [],
    references: [],
  }),
};

const index = createCodeIndex({
  workspaceRoot,
  syntaxProviders: [myProvider],
});
```

Custom provider functions cannot be structured-cloned into `WorkerCodeIndex`; if you need both, instantiate `CodeIndex` inside your own Electron utility/worker process.

## Search behavior

A query is evaluated locally using independent signals:

1. FTS5 lexical query over source chunks, paths and symbol labels.
2. Exact/partial symbol lookup.
3. Path lookup.
4. One-hop (configurable) graph expansion around strong symbol seeds.
5. Ripgrep/Node fallback only when the primary index returns nothing.

The signals are fused using weighted reciprocal-rank fusion. This avoids treating FTS5 BM25 scores, path scores and graph ranks as if they had a common scale.

## Graph behavior

Current graph edges:

- `contains`: file → symbol.
- `imports`: file → local workspace file, when deterministic module resolution succeeds.
- `calls`: source symbol/file → target symbol for resolvable direct calls.
- `extends` / `implements`: symbol → symbol when deterministically or uniquely resolvable.

Confidence is retained as `exact`, `resolved`, `syntactic` or `heuristic`.

For TS/JS, module resolution uses the TypeScript resolver when a `tsconfig.json` is present, including local path aliases that resolve to an indexed source file.

## Exact context reads

During indexing the package stores byte offsets for each source line. `getContext()` therefore opens the current source file and reads only the requested byte ranges rather than loading complete files into the LLM context path.

If `verifyFreshness` is enabled, the file's size/mtime is checked before a context read and the file is re-indexed first if it changed.

## Desktop resource policy

Recommended product settings:

- Use `WorkerCodeIndex` or run direct `CodeIndex` in an Electron utility process.
- Start with `maxConcurrency: 1` or `2`.
- Keep Xberg disabled until parser distribution is defined.
- Keep `maxFileBytes` bounded.
- Store the SQLite file under `app.getPath('userData')`, not in the repository.
- Pause/stop watch mode when the workspace is closed.
- Use periodic reconciliation because filesystem watch events are hints, not a source of truth.

## Tests included

The repository tests currently cover:

- initial workspace indexing,
- ignored dependency folders,
- JS/TS symbol extraction,
- lexical retrieval for generic non-JS language files,
- graph relationship generation,
- exact-range context reads,
- incremental single-file updates,
- persistent reopen,
- FTS5 replacement/removal/reset behavior,
- modern TypeScript variable export metadata,
- literal SQL `LIKE` wildcard handling,
- recursive watch updates,
- worker-thread usage and startup-error propagation.

Run:

```bash
npm test
```

Run the deterministic graph benchmark separately; timing is intentionally not part of the unit test suite:

```bash
npm run benchmark:graph -- 100 2000 10000
```

## Known deliberate limits

These are architectural limits, not hidden failures:

- No vector database or embeddings in V1.
- No cloud/backend indexing.
- No universal type-aware call graph.
- Dynamic dispatch/member calls are not guessed when the target cannot be determined safely.
- Non-relative imports for non-JS/TS languages are not universally resolved.
- Xberg's broader parser coverage is optional and can involve first-use grammar downloads.
- `better-sqlite3` is native and must be built or selected for the Node/Electron ABI and architecture that loads it.
- Graph edges are rebuilt as a complete deterministic set after changed-file batches; use the benchmark harness before deciding whether affected-subgraph updates are warranted.

See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the complete phased implementation and rollout plan.
