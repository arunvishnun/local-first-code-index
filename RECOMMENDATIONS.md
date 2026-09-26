# Implementation Review & Recommendations

Date: 2026-09-26
Scope: `local-first-code-index` package as committed (`7bb7cf9`), evaluated against its own README.md and IMPLEMENTATION_PLAN.md claims. This review installed dependencies, built the package, ran the test suite, and probed individual modules directly.

## Verdict

The architecture and code quality are solid — sensible schema, RRF fusion instead of naively combining scores, bounded fallback search, git-aware discovery, exact byte-range reads, a real worker-thread boundary. But **the package cannot currently do the one thing it exists to do**: on a stock, currently-supported Node.js runtime, it fails to construct an index at all. This is not a nitpick or an edge case — it is the first line of code that runs. Every test in the suite fails because of it. The plan document's claim that "the remaining work is primarily production hardening... not placeholder implementation required to make the package usable" (`IMPLEMENTATION_PLAN.md:1460`) is not accurate as of this review; §1 below is a functional blocker, not a hardening item.

Everything else found is fixable in isolation, but §1 should block any integration work until resolved, because it invalidates every downstream test/behavior claim in the README.

---

## 1. CRITICAL — `node:sqlite` on stock Node/Electron does not have FTS5, so the package cannot start

**Reproduced directly:**

```
$ node --version
v22.14.0        # official nodejs.org build, i.e. exactly the stated minimum ("Node 22.13+")

$ npm test
error: 'no such module: fts5'
code: 'ERR_SQLITE_ERROR'
  at SqliteStore.initialize (dist/storage/sqlite-store.js:22)
  at new SqliteStore
  at new CodeIndex
  at createCodeIndex
```

All 3 test files fail with the identical error. `src/storage/sqlite-store.ts:124` unconditionally runs:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(...)
```

inside the constructor's `initialize()`, with no try/catch and no capability check. Since FTS5 is the *only* lexical search path (`lexicalSearch()` in `sqlite-store.ts:244` queries `chunks_fts` directly, and `search-service.ts` has no non-FTS lexical path), this isn't a degraded mode — `new CodeIndex(...)` / `createCodeIndex(...)` throws synchronously before `start()` can ever be called.

**Root cause:** Official Node.js builds (confirmed for 22.x and 23.x; there is a still-open Node core issue, [nodejs/node#56476](https://github.com/nodejs/node/issues/56476), requesting FTS5 be enabled by default) ship `node:sqlite` compiled *without* `-DSQLITE_ENABLE_FTS5`. The only way to get FTS5 in `node:sqlite` today is to compile Node from source with `--sqlite-enable-fts5`, which is not something a desktop app can require of its Electron runtime. This has hit other projects making the same assumption (e.g. the "codegraph" package issue: *"v1.5.0 requires FTS5 which is missing in official Node.js builds"*).

The README's runtime section (`README.md:27-33`) says "Node 22.13+" and treats `node:sqlite` as a solved dependency modulo an experimental-flag warning — it does not mention FTS5 at all. This is the actual landmine, not the "experimental" label.

**Impact:** This is not a partial-degradation bug. It means:
- The package as shipped will fail for essentially every consumer running official Node.js or Electron (Electron embeds Node without custom SQLite compile flags).
- The worker-thread path makes this worse (see §2): the failure surfaces as an opaque `Code index worker exited with code 1` with no indication of the real cause.
- Every "verified" test/behavior claim in the README ("Tests included," "already implements... Phase 0 through Phase 7") is currently unverifiable on the stated target runtime, because the test process cannot get past the constructor.

**Recommended fix — pick one, in priority order:**

1. **Swap the storage engine to `better-sqlite3`** (or make it the default with `node:sqlite` as an opt-in). `better-sqlite3` bundles its own SQLite amalgamation compiled with FTS5 (and FTS3/4, JSON1, etc.) already enabled, and is the de-facto standard for exactly this desktop/Electron use case. This is the path of least resistance and removes the whole class of problem. The plan document already anticipated this exact fallback (`IMPLEMENTATION_PLAN.md:115-123`, "Possible later adapter: NodeSqliteStore / BetterSqlite3Store") — this review's finding is the concrete trigger to build it now rather than "if the need is measured."
2. **If `node:sqlite` must be kept** (e.g. to avoid a native-module/prebuild dependency in Electron packaging), add a capability probe at construction time (`try { db.exec("CREATE VIRTUAL TABLE probe USING fts5(x)") } catch`) and a real non-FTS5 lexical fallback — e.g. a manually maintained inverted-token index table with `LIKE`/token-set matching — so the package degrades instead of refusing to start. This is strictly worse than option 1 (slower, more code, two lexical engines to maintain) but avoids adding a native dependency.
3. At minimum, whatever is chosen, **update the README's runtime section** to state the FTS5 requirement explicitly and stop implying `node:22.13+` alone is sufficient.

**Do not** ship a "fix" that only catches the error and silently returns empty search results — that would convert a loud, correct failure into a silent, wrong one, which is worse for a package whose entire value proposition is deterministic retrieval.

---

## 2. HIGH — Worker thread swallows the real error behind a bare exit code

`src/worker-host.ts:8` constructs `new CodeIndex(workerData)` at module top level, outside of the message handler's try/catch (which only wraps per-message dispatch, `worker-host.ts:11-38`). Any exception during construction — the FTS5 error above, or a bad `storagePath`, or a permissions error — crashes the worker thread before it can report anything structured.

The parent side (`src/worker-client.ts:42-44`) then only sees:

```js
this.worker.on('exit', (code) => {
  if (!this.#closed && code !== 0) this.failAll(new Error(`Code index worker exited with code ${code}`));
});
```

So every pending/future call rejects with `Code index worker exited with code 1` — the actual `ERR_SQLITE_ERROR` / stack trace is lost. This is a bad debugging experience independent of §1: any future constructor-time failure has the same problem.

**Fix:** wrap construction in `worker-host.ts` in a try/catch and `postMessage` a structured startup-error event (or reject the first pending call) before letting the worker exit, so `WorkerCodeIndex` can surface the real `Error` to the caller instead of a synthesized one.

---

## 3. MEDIUM — `exported` flag is wrong for the most common modern export pattern

Verified directly against the compiled TypeScript provider:

```js
// input:
export const refreshTree = (path) => { return path; };
export function runApp() { return 1; }
export class Store { load() { return 1; } }

// output symbols[].exported:
refreshTree -> false   // WRONG
runApp      -> true
Store       -> true
load        -> true    // (method inherits container's export — arguably fine)
```

`src/parser/typescript-provider.ts:85`:

```ts
exported: isExported(node) || (node.parent ? isExported(node.parent) : false),
```

For a `VariableDeclaration` (the `const refreshTree = ...` case), the `export` modifier lives on the *grandparent* `VariableStatement`, not the immediate parent `VariableDeclarationList`. The one-level walk-up misses it. `export function` / `export class` are unaffected because the modifier sits directly on the declaration node itself.

**Impact:** `export const foo = () => {}` and `export const foo = function(){}` — the dominant pattern for React components, hooks, handlers, and utility functions in most modern TS/JS codebases — are silently mislabeled as non-exported. Anything downstream that uses `exported` as a signal (ranking public API surface, filtering symbols an agent should treat as "entry points") gets systematically wrong answers for a large fraction of real symbols, with no error or warning.

**Fix:** walk up to the enclosing `VariableStatement` for `VariableDeclaration` nodes specifically (`ts.isVariableStatement(node.parent?.parent)`), rather than checking only one level. Add a unit test with `export const x = () => {}` — the current test fixtures (`test/core.test.mjs`) only use `export function` / `export class`, which is exactly why this shipped unnoticed.

---

## 4. MEDIUM — Full graph rebuild on every single file change

`rebuildGraph()` (`src/graph.ts:46`) does `store.listFiles()`, `store.allSymbols()`, `store.allImports()`, `store.allReferences()` — i.e., reads the *entire* index — then does `store.replaceEdges(edges)`, which deletes and reinserts the *entire* edges table (`sqlite-store.ts:337-348`). This runs after **every** `indexFile()` call and after every watcher-debounced batch (`code-index.ts:136`, `code-index.ts:458`), not just after a full `indexWorkspace()`.

This is explicitly called out as a known future risk in the plan ("For very large repositories, replace full graph rebuild with affected-subgraph updates only after profiling demonstrates the need" — `IMPLEMENTATION_PLAN.md:811`), so it's not a hidden defect, but given that **watch mode** is presented as a headline capability for a live desktop app, every keystroke-triggered save on a large repo re-scans and rewrites the whole graph. This should be treated as a near-term priority, not a someday-optimize item, once real repos are used — it's the kind of thing that looks fine in the test fixtures (a handful of files) and becomes a visible UI stall on a real monorepo.

**Fix:** at minimum, debounce/coalesce graph rebuilds across a burst of watcher events (currently only the FTS index update is debounced via `flushWatchChanges`, but each call still triggers a full rebuild — batching already happens per debounce window, which helps, but a single edit on a 50k-symbol repo still pays the full-scan cost). Longer term, do the affected-subgraph update the plan describes.

---

## 5. LOWER PRIORITY / notes

- **Call-graph precision is a known, documented limitation, not a bug**: `graph.ts` resolves `foo.bar()` calls by matching the bare name `bar` against symbols, with no receiver-type awareness, falling back to a "unique global symbol name" heuristic (`confidence: 'heuristic'`) when nothing more specific resolves. The README and plan document this honestly ("no universal type-aware call graph"). No action needed beyond keeping the confidence labels visible to consumers, which the current API already does.
- **`symbolSearch`/`pathSearch` don't escape SQL `LIKE` wildcards** (`%`, `_`) in query tokens (`sqlite-store.ts:261-282`). Not a security issue (parameters are bound), but a token that happens to contain `%` or `_` will behave as a wildcard rather than a literal character, giving surprising matches. Minor; worth an `ESCAPE` clause if exact substring matching matters.
- **Filesystem-fallback discovery re-walks ignored directories partially**: `discoverWithFilesystem` (`discovery.ts:32-50`) checks ignore globs per-directory before recursing, which is correct and avoids walking into `node_modules`, etc. No issue found here — flagging only because it's the one place a naïve implementation commonly gets this wrong, and this one doesn't.
- **Docs vs. reality gap beyond §1**: README's "Tests included" section and IMPLEMENTATION_PLAN §22.2 ("Already implemented and passing") should not be read as current-state facts until §1 is fixed and `npm test` is re-verified green on the stated minimum Node version. Right now that section is aspirational, not observed.

---

## Suggested order of work

1. Fix §1 (storage engine / FTS5) — nothing else can be honestly validated until this is resolved. Recommend `better-sqlite3` as the default store.
2. Re-run the full test suite on the actual stated minimum runtime (fresh Node 22.13+ install, no manual compile flags) as a release gate — not just on whatever Node happened to be on the dev machine.
3. Fix §2 (worker error surfacing) so future failures of this class are debuggable instead of opaque.
4. Fix §3 (`exported` flag) and add a regression test using `export const x = () => {}` / `export const x = function(){}`.
5. Add a watch-mode stress test against a repo with a few thousand files/symbols to get real numbers on §4 before deciding whether affected-subgraph incremental resolution is needed now or later.
6. Once 1–4 are done, the "Known deliberate limits" and "Current implementation status" sections of the existing docs are close to being trustworthy as-is — they're well-scoped and honest about the graph/type-checking limitations; they just need the storage-layer premise underneath them to actually hold.
