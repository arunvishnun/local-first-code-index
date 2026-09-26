# Local-First Code Index Package — Detailed Implementation Plan

## 1. Objective

Build a reusable TypeScript npm package for desktop AI agents that indexes repositories locally, retrieves the smallest useful source ranges deterministically, and reduces repository-exploration work performed by expensive LLMs.

Primary product goals:

- no backend is required for indexing/retrieval;
- index data remains on the user's machine;
- all normal text source files remain searchable even without a language parser;
- JavaScript/TypeScript get deeper deterministic syntax and graph support;
- broader syntax parsing is pluggable;
- indexing is incremental and resource bounded;
- queries return references/ranges before source content;
- context reads load exact ranges, not whole files;
- package runs outside the renderer/UI thread;
- behavior is measurable with cost/latency/quality telemetry;
- parser or optional-tool failures degrade to a cheaper fallback instead of breaking the workspace.

The 20% cost and latency goals are release hypotheses, not assumptions. They must be validated per task cohort.

---

# 2. Package boundary

The npm package owns:

1. repository discovery;
2. file filtering;
3. hashing/change detection;
4. syntax extraction;
5. lexical index;
6. symbol index;
7. deterministic dependency/call graph edges;
8. persistence;
9. query ranking/fusion;
10. exact source-range reads;
11. incremental updates/watch handling;
12. telemetry;
13. optional parser/tool adapters.

The npm package does **not** own:

- model selection;
- prompt orchestration;
- LLM provider calls;
- agent planning;
- code execution/sandboxing;
- remote vector databases;
- cloud indexing.

Expected integration:

```text
User Prompt
    │
    ▼
Desktop Agent
    │
    ├── deterministic task? ──► local tool/action
    │
    └── repository context needed
             │
             ▼
      local-first-code-index
             │
      ranked refs/ranges
             │
             ▼
      exact local reads
             │
             ▼
       selected context
             │
             ▼
         LLM/router
```

---

# 3. Runtime and packaging decision

## 3.1 Runtime

Initial runtime target:

- Node 22.13+
- TypeScript source
- ESM package
- Electron main process / utility process / Node Worker thread

Reasoning:

- official Node 22 `node:sqlite` builds do not enable the required FTS5 module;
- `better-sqlite3` supplies a synchronous SQLite build with FTS5 for the local worker-oriented architecture;
- worker threads are available;
- modern filesystem watch support is available;
- ESM is straightforward in current Electron/Node releases.

The package should not run repository indexing inside a sandboxed Electron renderer.
The consuming Electron application owns native-module ABI preparation through its packaging system or `@electron/rebuild`.

## 3.2 Persistence

V1:

```text
better-sqlite3
    ├── relational metadata
    ├── symbols
    ├── imports/references
    ├── graph edges
    └── FTS5
```

FTS5 is a required capability and is probed during construction. A missing capability is a startup error rather than a silent lexical-search degradation.

V1 deliberately has one storage implementation. Introduce a `StorageAdapter` abstraction only when a second usable backend has a measured product requirement.

---

# 4. Public API

Required V1 surface:

```ts
createCodeIndex(config)
createWorkerCodeIndex(config)

index.start()
index.indexWorkspace()
index.reconcile()
index.indexFile(path)
index.removeFile(path)
index.reset()
index.close()

index.search(query, options)
index.findSymbol(name)
index.getRelated(symbolIdOrName)
index.getContext(request)
index.getStats()
```

Direct mode additionally exposes exact reads:

```ts
index.readExactRange(file, startLine, endLine)
```

Principle: the package returns structured evidence; the agent decides what to do with it.

---

# 5. Configuration model

Every expensive or product-sensitive behavior must be configurable.

## 5.1 Workspace/storage

- `workspaceRoot`
- `storagePath`

Desktop recommendation: derive a stable repo ID and keep the DB under application user data rather than modifying the repository.

## 5.2 Discovery

- `mode: auto | git | filesystem`
- `includeGlobs`
- `ignoreGlobs`
- `maxFileBytes`
- `binaryProbeBytes`
- `followSymlinks`
- `gitMaxBufferBytes`

## 5.3 Resource controls

- `maxConcurrency`
- `yieldEveryFiles`

Future optional controls:

- foreground/idle scheduler callback;
- battery-state callback;
- CPU pressure callback;
- memory budget callback.

These belong behind configuration rather than hard-coded platform APIs so the desktop shell can own product policy.

## 5.4 Watch controls

- enabled
- debounce interval
- reconciliation interval

## 5.5 Retrieval controls

- result limit
- RRF constant
- lexical weight
- symbol weight
- path weight
- graph weight
- graph depth
- graph seed count

## 5.6 Context controls

- maximum context tokens
- chars-per-token estimate
- lines before/after matched range
- freshness verification

## 5.7 Optional Xberg controls

- enabled
- explicit language allow-list
- fallback behavior

Xberg remains opt-in until parser download/distribution policy is decided.

---

# 6. Repository discovery

## Step 1 — Prefer Git when possible

For Git repositories use:

```bash
git ls-files -co --exclude-standard -z
```

Benefits:

- honors `.gitignore` and standard excludes;
- includes tracked files;
- includes untracked non-ignored files;
- avoids reimplementing Git ignore semantics;
- reduces scanning of dependency/build directories.

## Step 2 — Filesystem fallback

If Git is unavailable or the workspace is not a Git repository:

- recursively enumerate files;
- do not follow symlinks by default;
- apply package ignore patterns;
- apply caller include/ignore patterns.

## Step 3 — Default ignores

Exclude at least:

- `.git`
- `node_modules`
- `dist`
- `build`
- coverage output
- framework output (`.next`, `.turbo`, etc.)
- Python environments/cache
- target/build artifacts
- package's own default index directory
- source maps/minified output/lockfiles unless explicitly requested.

## Step 4 — Safety filtering

Before parsing:

1. stat file;
2. reject above maximum size;
3. read bounded binary probe;
4. reject likely binary files;
5. read full content only for accepted files.

Failure behavior: skip and continue; never fail the repository because one file cannot be indexed.

---

# 7. Language handling

## Tier 0 — Universal text index

Every accepted text file gets:

- path metadata;
- language label when detectable;
- hash;
- line offsets;
- FTS chunks;
- exact-range read capability.

This is the non-negotiable fallback.

## Tier 1 — TypeScript compiler provider

For:

- JS
- JSX
- TS
- TSX
- MJS/CJS/MTS/CTS

Extract:

- functions;
- function-valued variables;
- classes;
- methods;
- constructors;
- interfaces;
- enums;
- type aliases;
- namespaces/modules;
- properties;
- imports;
- exports flag;
- class/interface heritage;
- direct function/member-call names.

Use TypeScript's parser/compiler APIs because this ecosystem is mature and the desktop project is JS/TS heavy.

Do not require full type checking during indexing.

## Tier 2 — Optional Tree-sitter/Xberg

When explicitly enabled:

- use Tree-sitter language-pack structure/import extraction for additional languages;
- flatten nested structure into normalized symbols;
- keep its output behind the package's `SyntaxProvider` contract;
- allow the provider to fail without losing generic text indexing.

Important product policy:

- first-use Xberg parser loading can involve downloads;
- offline products must pre-fetch/package approved grammars or keep it disabled.

## Tier 3 — Future semantic providers

Add only when benchmarks justify them:

```text
SemanticProvider
    ├── TypeScript language service / tsserver
    ├── Pyright
    ├── rust-analyzer
    ├── gopls
    ├── clangd
    └── JDT
```

Use as enrichment, never as the prerequisite for indexing.

---

# 8. Normalized parser contract

All syntax providers must normalize into the same representation:

```ts
interface ParsedSyntax {
  parser: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  references: ParsedReference[];
  diagnostics?: string[];
}
```

This prevents Tree-sitter, TypeScript or future LSP-specific structures from leaking into retrieval/storage.

Provider selection order:

1. caller-specific providers;
2. TypeScript provider for JS/TS;
3. optional broad parser;
4. generic text.

A parser enriches an index. A parser never determines whether the file can be indexed at all.

---

# 9. Hashing and freshness

For each file persist:

- relative path;
- size;
- mtime;
- SHA-256 content hash;
- parser name;
- parse status;
- line-byte offsets;
- last index timestamp.

Initial/reconciliation flow:

```text
Discover file
   │
   ├─ same size + mtime ──► unchanged
   │
   ▼
Read file + hash
   │
   ├─ same hash ──► update metadata only
   │
   ▼
Parse + re-index this file
```

Watcher events are hints. Reconciliation remains the source of truth.

---

# 10. Line offsets and exact reads

At index time compute byte offset of every line start.

Example:

```text
line 1 -> byte 0
line 2 -> byte 28
line 3 -> byte 61
...
```

For a context request of lines 88–132:

```text
startByte = lineOffsets[87]
endByte   = lineOffsets[132] or fileSize
```

Use file-handle range reads.

Benefits:

- avoid loading full files during prompt construction;
- measure exact bytes read;
- give LLM only required source windows;
- support token/byte budgeting.

Freshness check before a context read:

- compare stat size/mtime;
- re-index file if stale;
- then read range from current offsets.

---

# 11. Chunking

V1 uses deterministic line chunks:

- default 80 lines;
- default overlap 10 lines.

Each chunk stores:

- file path;
- start/end lines;
- overlapping symbol labels;
- source text in FTS5.

Why not syntax-only chunks in V1:

- generic languages must still work;
- line chunks have predictable resource behavior;
- symbol metadata is searched separately;
- context selection later narrows to exact ranges.

Tree-sitter syntax-aware chunks can be evaluated later against the same retrieval benchmark.

---

# 12. SQLite schema

Core tables:

```text
meta
files
symbols
imports
refs
chunks
chunks_fts
edges
```

## files

Stores:

- identity/path;
- language;
- size/mtime/hash;
- parser status;
- line offsets;
- indexed timestamp.

## symbols

Stores:

- stable deterministic ID;
- file;
- name/kind;
- range;
- signature;
- export flag.

## imports

Stores:

- source file;
- raw module specifier;
- imported/local names;
- resolved workspace path if known.

## refs

Stores cheap syntax references such as:

- direct calls;
- extends;
- implements.

Unresolvable references remain facts without graph edges.

## chunks + FTS5

Metadata lives in `chunks`; searchable text lives in `chunks_fts`.

## edges

Stores normalized graph edges and confidence.

Schema must be versioned. Future schema changes need explicit migration/rebuild logic; never silently interpret a new schema using old code.

---

# 13. Graph construction

Do not attempt universal semantic graph construction.

Build only relationships that are cheap and explainable.

## File containment

```text
file ──contains──► symbol
```

Confidence: exact.

## Imports

Relative import resolution:

```text
./helper
./helper.ts
./helper/index.ts
...
```

For JS/TS also run TypeScript's module resolver when a tsconfig is present. This handles local path aliases when they resolve into indexed files.

```text
file A ──imports──► file B
```

Confidence: exact.

Do not create a local edge for an npm/external dependency unless it resolves into the indexed workspace.

## Direct calls

Example:

```ts
import { refreshTree } from './tree';

function run() {
  refreshTree();
}
```

Resolve in order:

1. same-file unique symbol;
2. named import to resolved local file;
3. unique workspace symbol only as a lower-confidence fallback.

Do not guess dynamic dispatch if there are multiple candidates.

## Heritage

For `extends` / `implements` resolve similarly by name/import context.

## Confidence

Retain:

- `exact`
- `resolved`
- `syntactic`
- `heuristic`

Retrieval can later weight these differently.

---

# 14. Search architecture

A user query goes through multiple deterministic indexes.

```text
                     Query
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
     FTS5           Symbols           Paths
       │               │               │
       └───────────────┼───────────────┘
                       │
                 strong symbols
                       │
                       ▼
                 Graph expansion
                       │
                       ▼
             Reciprocal-rank fusion
                       │
                       ▼
                 Ranked ranges
```

## Query normalization

Deterministically split:

- camelCase;
- snake_case;
- paths;
- punctuation.

No LLM query rewrite in V1.

## Lexical retrieval

Use FTS5 and built-in BM25 ordering.

Search columns:

- file path;
- symbol labels;
- chunk text.

## Symbol retrieval

Rank:

1. exact case-insensitive symbol match;
2. partial symbol match;
3. shorter name before longer name when otherwise equal.

## Path retrieval

Match normalized query tokens against path.

## Graph expansion

Only expand from a small number of high-confidence symbol seeds.

Default depth: 1.

Do not traverse the entire graph per query.

---

# 15. Rank fusion

Do not combine raw BM25, graph and path scores directly.

Use weighted reciprocal-rank fusion:

```text
contribution = weight / (K + rank)
```

Then:

```text
candidateScore = Σ contributions
```

Initial weights are product parameters, not claims of optimality.

Tune using retrieval evaluation:

- Recall@1
- Recall@5
- Recall@10
- MRR

for known relevant files/symbols.

---

# 16. Search fallback

Primary retrieval should handle most queries.

If it returns no results:

## Preferred fallback

Use locally available ripgrep.

Configuration:

- auto detect `rg`;
- or pass bundled executable path;
- or disable.

## Guaranteed fallback

If ripgrep is unavailable:

- scan only indexed text files;
- stop at `maxFiles`;
- stop at `maxBytes`;
- perform local token text matching.

Fallback is intentionally bounded so a failed index query does not turn into an uncontrolled full-repository read.

---

# 17. Context selection

Input:

- search results;
- token budget;
- line padding.

Procedure:

1. expand each result by configured surrounding lines;
2. merge overlapping ranges in the same file;
3. keep the best source score for a merged range;
4. sort ranges by score;
5. read exact bytes;
6. stop at context budget;
7. report truncation.

Return:

```ts
{
  snippets,
  estimatedTokens,
  bytesRead,
  truncated
}
```

The model/router receives this output, not arbitrary repository files.

---

# 18. Incremental updates

Watcher path:

```text
filesystem event
      │
      ▼
 debounce/coalesce
      │
      ▼
 stat/read/hash
      │
      ├─ deleted ──► remove file index
      │
      ├─ unchanged ─► metadata only/no work
      │
      ▼
 parse changed file
      │
      ▼
 replace file rows transactionally
      │
      ▼
 rebuild deterministic graph
```

For very large repositories, replace full graph rebuild with affected-subgraph updates only after profiling demonstrates the need.

Correctness first, then optimize the graph invalidation path from telemetry.
Unchanged direct file updates skip graph rebuilding, and watcher bursts perform one rebuild after the coalesced changed-file batch.

---

# 19. File watching

V1 uses Node recursive `fs.watch` where available.

Safety policy:

- debounce events;
- ignore package DB/output;
- process changed files only;
- on watcher error keep periodic reconciliation alive;
- never treat an event as proof that the manifest is complete.

Periodic reconciliation catches:

- missed events;
- coalesced changes;
- rename anomalies;
- files changed while app was asleep;
- externally restored workspaces.

---

# 20. Worker-thread isolation

Default desktop integration should use:

```ts
createWorkerCodeIndex(...)
```

This moves:

- synchronous SQLite;
- TypeScript parsing;
- FTS queries;
- filesystem scanning;
- graph resolution

off the caller thread.

The worker client exposes Promise APIs.

Limitation:

- custom parser functions/loggers cannot be structured-cloned.

For custom providers:

- instantiate direct `CodeIndex` inside your own Electron utility process or worker entry point.

---

# 21. Telemetry

Index metrics:

- file count;
- symbol count;
- import count;
- reference count;
- graph edge count;
- chunk count;
- total bytes indexed;
- generic parser fallbacks;
- parser failures.

Query metrics:

- query count;
- aggregate query latency;
- fallback-search count;
- exact bytes read.

Desktop integration should add per-task model metrics:

- model calls;
- input/output tokens;
- cache reads/writes;
- tool calls;
- total latency;
- task success.

Join index telemetry and agent telemetry using a task/turn ID at the host level.

---

# 22. Validation plan

## 22.1 Unit/integration tests

Required cases:

### Discovery

- normal source files;
- ignored dependency/build folders;
- include/ignore overrides;
- non-Git workspace;
- Git workspace;
- oversized file;
- binary file;
- symlink policy.

### Parsing

- JS;
- TS;
- TSX/JSX;
- malformed but parseable TS;
- unknown language fallback;
- optional parser failure fallback.

### Persistence

- initial DB;
- reopen existing DB;
- file replacement;
- file delete;
- reset/rebuild.

### Retrieval

- lexical exact text;
- camelCase symbol;
- path query;
- graph neighbor;
- empty result fallback;
- filters.

### Graph

- relative import;
- TS path alias;
- same-file direct call;
- imported direct call;
- ambiguous symbol should not create deterministic edge;
- inheritance.

### Context

- exact line read;
- UTF-8/non-ASCII text;
- overlap merging;
- token budget truncation;
- stale file refresh.

### Incremental/watch

- edit;
- delete;
- rename;
- burst edits;
- watcher error + reconciliation fallback.

### Worker

- lifecycle;
- search;
- context;
- events;
- shutdown.

## 22.2 Current verified tests in this package

Already implemented and passing:

- initial indexing;
- ignored `node_modules`;
- TS symbol extraction;
- generic Python/text retrieval;
- call/import graph behavior;
- exact context reads;
- incremental update;
- persistence/reopen;
- FTS5 replacement, removal and reset;
- modern TS variable export metadata;
- literal SQL `LIKE` wildcard behavior;
- recursive watch update;
- worker-thread API;
- structured worker startup failures.

These tests pass on stock Node 22.14. Continue validating the minimum version and target Node/Electron/platform matrix before product release.

---

# 23. Offline benchmark harness

Build a fixed corpus of real desktop-agent tasks.

Task classes:

1. locate implementation;
2. explain feature flow;
3. identify callers;
4. targeted edit;
5. bug fix;
6. add test;
7. cross-file refactor;
8. config/document lookup;
9. large monorepo navigation;
10. unsupported-language repository.

For every task define ground-truth relevant files/symbols where possible.

Treatment:

```text
A = existing agent retrieval/search loop
B = local-first-code-index retrieval + precise reads
```

Pin:

- repository revision;
- prompt;
- model/version;
- tool policy where possible.

Measure:

- Recall@K;
- MRR;
- files read;
- bytes read;
- tool calls;
- model calls;
- input tokens;
- output tokens;
- cache usage;
- time to first useful evidence;
- total task latency;
- task success.

---

# 24. Release gates

Do not release based only on token reduction.

Suggested gate:

```text
Quality: non-inferior to baseline within predefined tolerance
AND
one or more target cohorts show:
  ≥20% lower input tokens or model/search tool work
  and/or ≥20% lower end-to-end latency
```

Also enforce resource budgets:

- initial index latency;
- CPU utilization;
- memory/RSS;
- DB size;
- battery impact;
- watch-event CPU;
- query p95 latency.

Segment by repository size and language mix.

---

# 25. Desktop product integration

## Open repository

```text
Desktop app opens workspace
        │
        ▼
create WorkerCodeIndex
        │
        ▼
load persisted DB immediately
        │
        ▼
reconcile changed files
        │
        ▼
start watcher
```

The UI does not need to wait for a full rebuild when a compatible index already exists.

## Agent prompt

```text
agent receives user prompt
        │
        ▼
local search
        │
        ▼
ranked ranges
        │
        ▼
getContext(tokenBudget)
        │
        ▼
agent decides:
  local deterministic action
  OR LLM with selected evidence
```

## Close workspace

```text
stop watcher
flush/close DB
terminate worker
```

---

# 26. Resource protection cases

## Huge repository

- Git discovery where possible;
- max file size;
- bounded index workers;
- event-loop yielding;
- worker isolation;
- persisted DB;
- optional language allow lists;
- shallow graph traversal.

## Huge individual file

Skip above configured byte threshold.

Do not truncate and parse as though complete unless a future provider explicitly supports safe partial parsing.

## Generated repository output

Ignore by default and allow product-specific ignore patterns.

## Binary/media workspace

Binary probe rejects source indexing; file is not sent through generic text search.

## Parser crash/error

- log/emit fallback event;
- index text generically;
- continue workspace.

## Optional provider unavailable

Continue with next provider.

## Ripgrep unavailable

Use bounded Node fallback.

## Watcher unavailable

Continue with periodic reconciliation.

## Stale file before LLM context

Verify stat and re-index before range read.

## File deleted between search and read

Return no snippet for that range; do not fail entire context request.

## SQLite locked

Use a bounded busy timeout; keep one DB connection per index worker.

## SQLite corruption

Product release should add explicit corruption recovery policy:

1. detect open/quick-check failure;
2. rename corrupt index file;
3. create new DB;
4. rebuild in background;
5. never delete user source files.

This is recommended before large-scale rollout.

---

# 27. Security/privacy requirements

- no source upload from the indexing package;
- no remote vector DB;
- no telemetry containing source text by default;
- store index under application-controlled local path;
- validate workspace-relative paths before reading;
- do not follow symlinks unless explicitly enabled;
- cap file size;
- cap fallback reads;
- cap parser inputs;
- do not execute source code during indexing;
- treat Xberg first-use downloads as an explicit network/product-policy decision;
- keep LLM inference privacy separate from indexing privacy.

---

# 28. Xberg adoption plan

Do not make Xberg the package's foundation initially.

## Stage A

Ship baseline with:

- TypeScript compiler parser;
- generic text fallback.

Measure retrieval quality on non-JS/TS repos.

## Stage B

Enable Xberg in an offline benchmark for selected languages:

- Python;
- Java;
- Go;
- Rust;
- Kotlin;
- Swift.

Measure incremental value:

```text
Recall@K improvement
minus
CPU/index time/DB size/parser distribution cost
```

## Stage C

If valuable, prefetch an approved grammar set in desktop packaging so normal indexing does not require an internet fetch.

## Stage D

Expand supported grammar set only from observed repository-language demand.

---

# 29. Future LSP/semantic enrichment plan

Only add language-server integration for failure classes where syntax + lexical retrieval is insufficient.

Examples:

- overloaded methods;
- interface implementations;
- dynamic module resolution;
- exact references;
- cross-package symbols in monorepos.

API shape:

```ts
interface SemanticProvider {
  supports(language: string): boolean;
  definitions(...): Promise<Definition[]>;
  references(...): Promise<Reference[]>;
}
```

Rules:

- optional;
- local-only;
- budgeted;
- not required for startup;
- cache outputs;
- disable under high load;
- measure retrieval benefit before rollout.

---

# 30. Optional semantic embeddings

Do not add embeddings until lexical/symbol/graph benchmark data identifies a semantic recall gap.

If added:

- local model only for the local-first product mode;
- selective chunks, not every possible artifact;
- local ANN store;
- hard disk/RSS/CPU caps;
- background/idle only;
- disableable;
- separately measure marginal recall and task success.

Embedding value must exceed:

- additional index time;
- model download size;
- battery/CPU;
- disk;
- maintenance complexity.

---

# 31. Production hardening backlog

Before broad release, add/complete:

1. schema migration/rebuild manager;
2. SQLite corruption recovery;
3. structured index-progress API;
4. cancellation/abort signals;
5. host-supplied idle/power policy;
6. per-repository disk quotas;
7. DB vacuum/maintenance policy;
8. affected-subgraph incremental resolution if graph rebuild becomes material;
9. parser timing telemetry by language;
10. Xberg parser prefetch/distribution workflow if adopted;
11. optional storage backend abstraction if Electron runtime policy requires it;
12. benchmark harness and dashboards;
13. quality gates and staged feature rollout;
14. security review of optional native parser packages;
15. OSS-license inventory for bundled parsers/binaries.

---

# 32. Implementation sequence

## Phase 0 — Baseline instrumentation

Host application first records current:

- model calls;
- tokens;
- search/read calls;
- bytes read;
- latency;
- task result.

Exit criterion: baseline distributions exist.

## Phase 1 — Core package + persistence

Implement:

- config;
- SQLite schema;
- discovery;
- hash manifest;
- generic chunks;
- exact line offsets.

Exit criterion: reopenable local index works with no parser.

## Phase 2 — JS/TS structure

Implement TypeScript compiler provider.

Exit criterion: expected symbols/imports/ranges extracted from real JS/TS projects.

## Phase 3 — Search

Implement:

- FTS5;
- symbols;
- paths;
- RRF.

Exit criterion: benchmark Recall@K beats plain repeated filesystem searching on target navigation tasks.

## Phase 4 — Deterministic graph

Implement:

- contains;
- relative import resolution;
- TS module resolver;
- direct call/heritage resolution.

Exit criterion: multi-file navigation improves without unacceptable graph cost.

## Phase 5 — Context selector

Implement exact byte-range reads and budgets.

Exit criterion: bytes/tokens sent to models materially decrease with no retrieval-quality regression.

## Phase 6 — Incremental/watch

Implement:

- file watcher;
- debounce;
- changed-file indexing;
- deletes;
- periodic reconciliation.

Exit criterion: index remains fresh during normal editing without high CPU.

## Phase 7 — Worker isolation

Implement worker RPC facade.

Exit criterion: desktop UI/main event loop remains responsive during initial indexing and large searches.

## Phase 8 — Evaluation

Run A/B offline.

Exit criterion: quality non-inferiority plus measurable cost/latency value.

## Phase 9 — Broader language enrichment

Evaluate Xberg using selected language cohorts.

Exit criterion: measured incremental retrieval value exceeds resource/distribution cost.

## Phase 10 — Production experiment

Gradual index-on/index-off cohort rollout with identical telemetry definitions.

Exit criterion: production metrics confirm offline result.

---

# 33. Current implementation status

The supplied package already implements the V1 path through Phase 7:

- configuration;
- SQLite/FTS5 persistence;
- repository discovery;
- generic language fallback;
- JS/TS TypeScript parsing;
- optional Xberg adapter;
- hashes and line offsets;
- lexical/symbol/path search;
- weighted RRF;
- deterministic graph;
- exact range reads;
- context budgeting;
- watcher/reconciliation;
- bounded fallback search;
- worker client;
- telemetry;
- integration tests.

The FTS5 runtime blocker, worker startup diagnostics, modern variable export metadata and literal `LIKE` matching are implemented and regression-tested. Remaining work is production hardening, cross-platform packaging validation, broader benchmarking and product integration.

---

# 34. Acceptance criteria for desktop integration

A repository is considered successfully integrated when all of the following are true:

1. opening a repository creates/loads a local DB under app data;
2. UI remains responsive during indexing;
3. ignored dependency/build folders are not indexed;
4. JS/TS symbols are searchable;
5. unsupported language text is still searchable;
6. editing a file updates source rows without a full repository reparse; graph edges may be rebuilt as one deterministic set after a changed-file batch;
7. deleting/renaming a file eventually reconciles correctly;
8. search returns ranked file/range references;
9. context reads only requested source windows;
10. stale files are refreshed before context reads;
11. no indexing source data is sent to a backend;
12. package works with Xberg disabled;
13. optional parser failure does not break search;
14. desktop host records per-task retrieval/model telemetry;
15. offline A/B confirms quality non-inferiority before default-on rollout;
16. the packaged Electron application loads `better-sqlite3`, creates a file-backed index and completes a lexical-search smoke test on every shipping platform.

