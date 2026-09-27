# local-first-code-index

Local repository index and deterministic retrieval for a desktop coding agent.

The package runs entirely on the machine. It discovers files, parses them, stores symbols and relationships in SQLite, and returns small source ranges. The host agent sends that context pack to the coding model. This package does not call a model, a network API, or an embedding service.

Typical host flow:

1. Open a workspace and call `start()`.
2. On each user request, call `retrieveContext()` with the request text, the current file, and a budget.
3. Send `primary` and `related` snippets to the model.
4. Call `findReferences`, `getSnippet`, or `retrieveContext` again only when the model still lacks a specific range.
5. Read a full file only when applying an edit.

## Requirements

- Node.js **22.13** or newer.
- macOS and Windows are both supported. CI installs, typechecks, tests, and runs the retrieval benchmark on Ubuntu, macOS, and Windows.
- `better-sqlite3` is a native module. Stock Node uses its prebuilt binary when one exists for that ABI and architecture.
- Electron must rebuild `better-sqlite3` for the Electron ABI. Electron Forge does this in its normal packaging flow. Other apps can use [`@electron/rebuild`](https://github.com/electron/rebuild) from the application, aimed at that app's Electron version:

```bash
npx electron-rebuild -f -w better-sqlite3
```

Run the index from the Electron main process, a utility process, or `WorkerCodeIndex`. A sandboxed renderer is the wrong place for repository indexing.

## Install

```bash
npm install local-first-code-index
```

The package exports ESM. `@xberg-io/tree-sitter-language-pack` is optional and is not required for JavaScript, TypeScript, or plain text.

Public entry points:

```ts
import {
  createCodeIndex,
  createWorkerCodeIndex,
  TypeScriptSyntaxProvider,
  GenericSyntaxProvider,
  XbergSyntaxProvider,
  normalizeConfig,
  DEFAULT_EXTENSION_LANGUAGE_MAP,
} from 'local-first-code-index';
```

Types are exported from the same module.

## Use it from Electron

Store the database under the app's user-data directory, outside the repository. `examples/electron-main.ts` is a complete version of this pattern.

```ts
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { createWorkerCodeIndex } from 'local-first-code-index';

function repoId(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
}

export async function openRepositoryIndex(workspaceRoot: string) {
  const index = createWorkerCodeIndex({
    workspaceRoot,
    storagePath: path.join(app.getPath('userData'), 'code-indexes', repoId(workspaceRoot), 'index.sqlite'),
    watch: { enabled: true, debounceMs: 150, reconcileIntervalMs: 300_000 },
    resources: { maxConcurrency: 2 },
  });

  index.onEvent((event) => {
    // Forward `status` and `index-progress` to the desktop UI.
    console.debug('[code-index]', event);
  });

  await index.start();
  return index;
}

export async function buildAgentContext(index: Awaited<ReturnType<typeof openRepositoryIndex>>, prompt: string, currentFile?: string) {
  const pack = await index.retrieveContext({
    query: prompt,
    ...(currentFile ? { currentFile } : {}),
    budget: {
      maxFiles: 6,
      maxSnippets: 8,
      maxLines: 240,
      maxBytes: 24_000,
      maxEstimatedTokens: 4_000,
      maxGraphDepth: 1,
    },
  });

  return {
    confidence: pack.confidence,
    warnings: pack.warnings,
    snippets: [...pack.primary, ...pack.related].map((snippet) => ({
      file: snippet.filePath,
      lines: `${snippet.range.startLine}-${snippet.range.endLine}`,
      reason: snippet.reason,
      symbol: snippet.symbol?.name,
      content: snippet.content,
    })),
    imports: pack.imports,
    relationships: pack.relationships,
    nextCandidates: pack.nextCandidates,
    metrics: pack.metrics,
  };
}
```

Send `snippets` to the model. `nextCandidates` are paths and scores only, with no source text. Read one of them with `getSnippet` if the model asks for it.

`WorkerCodeIndex` cannot accept `syntaxProviders` or a `logger`, because functions cannot be cloned into a worker. For a custom parser, construct `CodeIndex` inside your own utility process.

`AbortSignal` also cannot cross the worker boundary. Call `index.cancel()` to abort the worker's current `start`, `indexWorkspace`, `search`, or `retrieveContext`.

## Use it directly

Use `CodeIndex` in a Node process or a worker you already own.

```ts
import { createCodeIndex } from 'local-first-code-index';

const index = createCodeIndex({
  workspaceRoot: '/repo',
  storagePath: '/app-data/repo-123/index.sqlite',
});

const run = await index.start();
console.log(index.getIndexState().status, run.indexed, run.unchanged);

const pack = await index.retrieveContext({
  query: 'where is retryPayment defined',
  currentFile: 'src/billing/checkout.ts',
  openFiles: ['src/billing/checkout.ts'],
  intent: 'definition',
});

const definition = index.getDefinition('retryPayment');
const references = index.findReferences('retryPayment');
const outline = index.getFileOutline('src/billing/checkout.ts');
if (definition) {
  const snippet = await index.getSnippet(definition.filePath, definition.startLine, definition.endLine);
  console.log(snippet?.content);
}

await index.close();
```

`:memory:` is a valid `storagePath` for tests. If `storagePath` is omitted, the database is created at `<workspaceRoot>/.local-code-index/index.sqlite`. Prefer an application-data path so the index is not inside the repo.

## Context pack

`retrieveContext` is the call meant for an agent. It returns structured data, not prose.

```ts
interface ContextPack {
  query: string;
  intent: RetrievalIntent;
  confidence: 'high' | 'medium' | 'low' | 'none';
  warnings: string[];
  status: IndexStatus;
  primary: ContextPackSnippet[];   // source to send
  related: ContextPackSnippet[];    // expanded source, still inside the budget
  relationships: ContextRelationship[];
  imports: ContextImport[];         // metadata, not import-block source
  nextCandidates: ContextCandidate[]; // no source text
  metrics: RetrievalMetrics;
  truncated: boolean;
}
```

Each snippet has `filePath`, `range`, `content`, `reason`, `score`, `signals`, `estimatedTokens`, `bytes`, and the symbol when one was matched.

`confidence` is `high` for an exact symbol match, `medium` for an index lexical or path match, `low` when only the ripgrep/Node fallback matched, and `none` when nothing matched. Low-confidence packs include a warning. Empty packs include `No indexed match.`

### Intent

Pass `intent` when the host already knows what it needs. If omitted, the package infers one from the query text with keyword rules:

| Intent | What the pack keeps |
|---|---|
| `definition` | Exact symbol range. Other hits stay in `nextCandidates`. |
| `usages` | Definition, then reference lines. |
| `callers` | Definition, then `call` references. |
| `callees` | Definition, then resolved outgoing calls. |
| `tests` | Definition, then the paired `*.test` / `*.spec` file. |
| `implementation` | Definition, then `extends` / `implements` references. |
| `route` | Lexical and path hits, narrowed to a matching symbol when one overlaps the chunk. |
| `general` | Same narrowing, plus direct relationships when an exact symbol was found. |

A single identifier such as `retryPayment`, or a camel-case token inside a sentence, is looked up as an exact symbol before lexical search.

### Budget

```ts
interface ContextBudget {
  maxFiles: number;          // default 6
  maxSnippets: number;       // default 8
  maxLines: number;          // default 240
  maxBytes: number;          // default 24000
  maxEstimatedTokens: number; // default 4000, or context.defaultMaxTokens
  maxGraphDepth: number;     // default 1
}
```

Any one limit stops further expansion. `truncated` is then `true`, and leftover hits are listed in `nextCandidates`. Snippet padding uses `context.linesBefore` and `context.linesAfter` (default 3) and is clamped to the remaining line budget.

`getContext({ results, maxTokens })` is the older token-budget reader. It still merges overlapping ranges and reads exact bytes. Prefer `retrieveContext` for agent prompts.

## API

`CodeIndex` methods are synchronous when they only touch SQLite, and async when they read the filesystem. `WorkerCodeIndex` exposes the same surface as async methods, plus `cancel()`. `readExactRange` exists only on `CodeIndex`; use `getSnippet` from the worker.

### Lifecycle

| Method | Behavior |
|---|---|
| `start(options?)` | Index the workspace, then start the watcher when `watch.enabled` is true. |
| `indexWorkspace(options?)` | Discover files, index changed files, delete missing files, rebuild graph edges. |
| `reconcile()` | Alias of `indexWorkspace()`. |
| `indexFile(path)` | Reparse one file when its content or parser version changed. |
| `removeFile(path)` | Delete one file and its symbols, chunks, and edges. |
| `reset()` | Clear the database and index again. |
| `close()` | Stop the watcher and close SQLite. Safe to call twice. |
| `startWatching()` / `stopWatching()` | Control the watcher after startup. |
| `cancel()` | `WorkerCodeIndex` only. Aborts the current operation. |

`indexWorkspace({ signal })` accepts an `AbortSignal`. A cancelled run keeps files already written. Status becomes `STALE` when the database has files, and `NOT_INDEXED` when it does not.

`start()` and `indexWorkspace()` return:

```ts
interface IndexRunResult {
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
```

`ignored` counts paths excluded by include/ignore globs after discovery. Git's own ignored files never appear in that count because `git ls-files` already drops them.

### Retrieval

| Method | Behavior |
|---|---|
| `retrieveContext(request)` | Build a budgeted context pack. |
| `getRelatedContext(symbol, budget?)` | `retrieveContext` with `intent: 'general'` for that name. |
| `search(query, options?)` | Fused lexical, symbol, path, graph, and proximity results. |
| `findSymbol(name, limitOrOptions?)` | Exact case-insensitive name match. A number sets the limit. An object may set `limit`, `kind`, `role`, and `pathPrefix`. |
| `findReferences(nameOrId, limit?)` | Stored call, JSX, extends, and implements sites. |
| `getDefinition(nameOrId)` | Symbol row by id, otherwise the first exact name match. |
| `getSnippet(file, startLine, endLine)` | One byte-bounded read. |
| `getFileOutline(file)` | Symbols in a file, with ranges and roles, without loading the file into a prompt. |
| `getRelated(nameOrId)` | Incoming and outgoing graph edges for a symbol, plus import edges for its file. |
| `getContext(request)` | Merge search ranges and read them under `maxTokens`. |
| `readExactRange(file, startLine, endLine)` | Direct `CodeIndex` byte read. |
| `getIndexState()` | Status, revision, last full run, last incremental update, last error. |
| `getLastRetrieval()` | Metrics from the latest `search` or `retrieveContext`. |
| `getStats()` | Database counts plus runtime counters. |
| `onEvent(listener)` | Subscribe. Returns an unsubscribe function. |

Search options:

```ts
interface SearchOptions {
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
```

`currentFile` adds `search.proximityWeight` (default `0.02`). Each path in `openFiles` adds half of that. Another file in the same directory adds `search.moduleWeight` (default `0.008`). Matching results include a `proximity` reason.

### Status and events

`getIndexState().status` is one of:

| Status | Meaning |
|---|---|
| `NOT_INDEXED` | The database has no files. |
| `INDEXING` | A full index or reconcile is running. |
| `READY` | The last full index finished. |
| `STALE` | A watch event is queued, or a cancelled index left a partial database. |
| `ERROR` | The last full index threw. `lastError` has the message. |

Search still works during `INDEXING` and `STALE`. The context pack repeats that status in `warnings`.

Events emitted on `'event'`:

| Event | When |
|---|---|
| `index-start` | A full index begins. |
| `index-progress` | Every `resources.yieldEveryFiles` files, and when the scan finishes. Fields: `completed`, `total`, `filePath`. |
| `index-complete` | A full index finishes. Includes `IndexRunResult`. |
| `file-indexed` | One file was written. Includes `parser`. |
| `file-removed` | One file was deleted from the index. |
| `parse-fallback` | A structured parser failed and text indexing was used. |
| `watch-error` | The filesystem watcher failed. Periodic reconcile still runs when configured. |
| `status` | Status changed. `error` is set for `ERROR`. |

A parser exception in one file does not fail the workspace index. That file is skipped or stored through the generic text parser, and the rest of the run continues.

## Configuration

```ts
createCodeIndex({
  workspaceRoot: '/repo',                          // required
  storagePath: '/app-data/index.sqlite',           // recommended

  watch: {
    enabled: false,              // start() starts the watcher when true
    debounceMs: 150,
    reconcileIntervalMs: 300_000, // 0 disables the periodic reconcile
  },

  discovery: {
    mode: 'auto',                // 'auto' | 'git' | 'filesystem'
    includeGlobs: ['**/*'],
    ignoreGlobs: ['**/generated/**'], // appended to the defaults below
    maxFileBytes: 2 * 1024 * 1024,
    binaryProbeBytes: 8192,
    followSymlinks: false,
    gitMaxBufferBytes: 64 * 1024 * 1024,
  },

  chunks: {
    lines: 80,                   // FTS chunk size
    overlapLines: 10,
  },

  graph: {
    enabled: true,
    resolveOnIndex: true,        // rebuild edges after a full index or a changed file
    includeDirectCalls: true,
  },

  search: {
    defaultLimit: 20,
    rrfK: 60,
    lexicalWeight: 1,
    symbolWeight: 1.4,
    pathWeight: 0.8,
    graphWeight: 0.7,
    proximityWeight: 0.02,
    moduleWeight: 0.008,
    graphDepth: 1,
    graphSeedLimit: 6,
  },

  context: {
    defaultMaxTokens: 6000,      // used by getContext
    charsPerToken: 4,            // estimated tokens = ceil(chars / charsPerToken)
    linesBefore: 3,
    linesAfter: 3,
    verifyFreshness: true,       // reindex a file when size or mtime changed before a read
    budget: {
      maxFiles: 6,
      maxSnippets: 8,
      maxLines: 240,
      maxBytes: 24_000,
      maxEstimatedTokens: 4_000,
      maxGraphDepth: 1,
    },
  },

  fallbackSearch: {
    enabled: true,
    ripgrepPath: 'auto',         // 'auto' | absolute path | false
    maxFiles: 500,
    maxBytes: 8 * 1024 * 1024,
  },

  resources: {
    maxConcurrency: 2,
    yieldEveryFiles: 10,         // progress event interval; also yields the event loop
  },

  xberg: {
    enabled: false,
    languages: [],
    fallBackOnError: true,
  },

  extensionLanguageMap: {},      // merged over DEFAULT_EXTENSION_LANGUAGE_MAP
  syntaxProviders: [],           // CodeIndex only
  logger: undefined,
});
```

`normalizeConfig` fills these defaults. Extra `ignoreGlobs` are added to the built-in list:

`**/.git/**`, `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/coverage/**`, `**/.next/**`, `**/.turbo/**`, `**/.cache/**`, `**/.local-code-index/**`, `**/target/**`, `**/.venv/**`, `**/venv/**`, `**/__pycache__/**`, `**/.idea/**`, `**/.vscode/**`, `**/*.min.js`, `**/*.min.css`, `**/*.map`, `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/yarn.lock`.

Discovery mode `auto` uses `git ls-files -co --exclude-standard` and falls back to a filesystem walk when git is unavailable. Mode `git` throws if git fails. Mode `filesystem` always walks. Files larger than `maxFileBytes`, and files whose leading bytes look binary, are skipped. One malformed file does not abort the run.

## What gets indexed

For every included text file the index stores:

- path, language, size, mtime, content hash, parser name, parser version
- line byte offsets, used for range reads
- overlapping source chunks in an FTS5 table
- symbols, imports, and references when a parser produced them

A file is left untouched when size, truncated mtime, content hash, and parser version all match. An ordinary edit reparses that file, replaces its rows, and rebuilds the relationship set. Unchanged files are not reread. The relationship rebuild is still a full deterministic pass over the indexed graph, not an affected subgraph.

SQLite uses WAL for file-backed databases. Schema version is `2`. A database written at schema `1` is migrated in place by adding `files.parser_version` and `symbols.role`. A database from a newer schema throws `CodeIndexStorageError` and asks for a new storage path or a newer package. FTS5 is required; construction throws `CodeIndexStorageError` with code `CODE_INDEX_FTS5_UNAVAILABLE` when the loaded SQLite binary lacks it.

Search results and exact symbol lookups are cached in memory. The cache key includes the index revision, so a write invalidates older results.

## Search

`search` fuses independent lists with weighted reciprocal rank fusion:

```text
contribution = weight / (rrfK + rank)
```

The lists are:

1. FTS5 BM25 over chunk text, file paths, and symbol names in the chunk.
2. Exact symbol name, then substring symbol name.
3. Path substring match.
4. Graph neighbors of the top symbol seeds, when `expandGraph` is true (the default). Depth defaults to 1.
5. Ripgrep, or a bounded Node scan, only when the fused list is empty and fallback is enabled.

`retrieveContext` runs its own bounded expansion and asks `search` not to expand the graph, so a context pack does not duplicate neighbor chunks. Lexical chunk hits are narrowed to the smallest overlapping symbol whose name contains a query token.

Reasons on each hit use `source`: `lexical`, `symbol`, `path`, `graph`, `proximity`, or `fallback`.

## Graph

Edges:

| Type | Meaning |
|---|---|
| `contains` | File contains a symbol. |
| `imports` | File imports another indexed file. Relative specifiers are resolved directly. TypeScript also uses `tsconfig.json` path aliases when the result is inside the workspace. |
| `calls` | A direct call whose target resolves to one symbol in the same file, through an import, or as the only symbol with that name. |
| `extends` / `implements` | Heritage clauses resolved the same way. |
| `references` | Other resolved names, including JSX components (`<CheckoutForm />`). |
| `tests` | `foo.test.ts` or `foo.spec.ts` paired with `foo.ts`. A file under `__tests__/` is also paired with the same name in the parent directory. |

Confidence is `exact`, `resolved`, `syntactic`, or `heuristic`. A call that could point at several symbols is not given an edge. Dynamic dispatch is left unresolved.

Graph expansion in both search and context packs stops at `maxGraphDepth` / `graphDepth`.

## Languages

Any non-binary text file is indexed for path and lexical search, even when no language parser exists.

| Capability | Any text file | JavaScript / TypeScript | Xberg language, when enabled |
|---|---|---|---|
| Path index and FTS5 | yes | yes | yes |
| Exact range reads | yes | yes | yes |
| Symbols | no | functions, methods, classes, interfaces, enums, types, variables, constructors, namespaces | where that extractor emits them |
| Imports and direct calls | no | yes, deterministic subset | depends on the provider |
| Components and hooks | no | `role: 'component'` for PascalCase functions in `.jsx` / `.tsx`; `role: 'hook'` for functions named `useX` | no |
| Compiler-grade references | no | no | no |

JavaScript and TypeScript are parsed with the TypeScript compiler API. Exported means the declaration has `export` or `default`, or the local name appears in an export list such as `export { refreshTree }`.

Provider order:

1. `syntaxProviders` passed to `createCodeIndex`
2. TypeScript compiler provider
3. Xberg, when `xberg.enabled` is true
4. generic text fallback

Xberg is off by default. Its language pack can download grammars on first use. Leave it off for a fully offline app, or enable specific languages after those grammars are packaged with the app:

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

A custom provider:

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
  storagePath,
  syntaxProviders: [myProvider],
});
```

`supports` and `parse` may be async. A provider that throws is skipped. With `xberg.fallBackOnError` left at its default, the file is still text-indexed.

## Watching

`watch.enabled` uses Node's recursive `fs.watch`, which is available on macOS and Windows in Node 22. Changes are debounced, then each added, edited, or deleted path is updated. A rename is handled as a delete plus an add. Events are hints: `reconcileIntervalMs` runs a full reconcile on that interval so a missed event is repaired. Set the interval to `0` to disable it.

Call `stopWatching()` when the workspace closes.

## Metrics

`getLastRetrieval()` describes the latest search or context pack:

- duration, index queries, graph expansions
- snippets, files, source lines, bytes, estimated tokens
- full-file bytes avoided, estimated as indexed file size minus returned snippet bytes
- cache hit or miss, index hit, fallback count
- index revision and status

`getStats()` adds database totals (`files`, `symbols`, `imports`, `references`, `edges`, `chunks`, `totalBytesIndexed`) and process counters (`queries`, `queryLatencyMsTotal`, `exactBytesRead`, `fallbackSearches`, `parseFailures`, `genericFallbacks`, cache counters, `retrievals`, `sourceBytesReturned`, `estimatedTokensReturned`).

`getIndexState().lastIncremental` records the last single-file or watch flush: changed files, files reparsed, whether relationships were recalculated, elapsed time, cache invalidations, and revision.

Nothing in this package sends telemetry off the machine.

## Develop

```bash
npm test                  # build, then node --test
npm run typecheck
npm run benchmark:retrieval
npm run benchmark:graph -- 100 2000 10000
```

`benchmark:retrieval` builds a small Next-style fixture, then the same fixture plus 80 and plus 250 generated files. It compares `retrieveContext` with an in-process scan that treats every matching file as a full read. Output is printed and written to `benchmark/output/retrieval.json`. Those numbers describe that run's fixtures. They are not a promise about every repository, and the model-call column is a stand-in for round trips, not a live model.

`benchmark:graph` times relationship rebuilds at the requested symbol counts. Timing is kept out of the unit tests.

The tests cover indexing, ignore rules, symbol and export metadata, lexical search, graph edges, exact reads, incremental updates, reopening a database, FTS replacement, watch updates, worker startup errors, context budgets, references, component and hook roles, ranking proximity, cache invalidation, cancellation, parser isolation, and schema migration.

## Limits

- Retrieval is lexical and structural. There is no embedding index and no semantic search.
- The call graph covers direct calls and heritage that resolve to one symbol. Overloaded or dynamic targets are omitted.
- Non-JS/TS imports are resolved when the specifier is relative and the target file is indexed.
- Component detection requires a PascalCase function in a JSX file. Hook detection requires a function whose name matches `use` followed by an uppercase character.
- Test links follow filenames (`*.test.*`, `*.spec.*`), not a test runner's dependency graph.
- After an edit, one file is reparsed and the whole relationship set is rebuilt.
- On very small files, a lexical hit can be the entire file, so a vague query may return about as much text as reading the matches.
- Xberg can download grammars unless you leave it disabled or ship the grammars yourself.
- `better-sqlite3` must match the Node or Electron ABI that loads it.
