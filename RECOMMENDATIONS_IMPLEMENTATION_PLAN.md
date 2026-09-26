# Recommendations Remediation Implementation Plan

Date: 2026-09-26  
Source review: [`RECOMMENDATIONS.md`](./RECOMMENDATIONS.md)  
Baseline commit: `7bb7cf9`

## 1. Goal

Make `local-first-code-index` usable on its declared Node runtime and in its intended Electron/desktop environment, then close the correctness and operability gaps identified in `RECOMMENDATIONS.md`.

The package is considered usable when a consumer can:

1. install it with a stock supported Node.js runtime;
2. construct an index without requiring a custom Node build;
3. index and search a repository with lexical, symbol, path, and graph signals;
4. run the same operations through `WorkerCodeIndex`;
5. receive the original startup error when initialization fails;
6. package the dependency in Electron using documented native-module tooling.

## 2. Validated baseline

The following findings were reproduced against the baseline:

- Node `v22.14.0` does not expose FTS5 through `node:sqlite`.
- `npm test` builds successfully but all three test files fail at runtime.
- Direct construction fails with `ERR_SQLITE_ERROR: no such module: fts5`.
- Worker construction hides that error behind `Code index worker exited with code 1`.
- `export const refreshTree = () => {}` is recorded as `exported: false`.
- Graph rebuilding reads and replaces the complete graph after a direct file update.

Two qualifications apply to the source recommendations:

- The cited Node issue is closed, although official Node 22 still lacks built-in FTS5.
- `better-sqlite3` is a native dependency. Electron consumers may need an Electron-specific prebuild or rebuild, so the host application must own Electron ABI preparation.

## 3. Architectural decisions

### 3.1 Storage backend

Use `better-sqlite3` as the only storage backend for the current `0.1.x` package.

Do not add a public storage adapter or retain a second `node:sqlite` implementation in this remediation. A dual implementation would increase migration, query, and test complexity while one backend is known not to satisfy the package's required FTS behavior.

Keep the existing `SqliteStore` class name and internal method surface. This limits the change to the storage implementation and avoids unnecessary changes in `CodeIndex`, `SearchService`, and graph construction.

### 3.2 FTS5 behavior

FTS5 remains required. The package must fail early with an actionable storage error if the loaded SQLite binary does not support it.

Do not silently disable lexical retrieval and do not return empty lexical results. Such behavior would make successful construction misleading and would violate the package's deterministic retrieval intent.

### 3.3 Electron ownership

Add `better-sqlite3` as a normal runtime dependency so Node consumers receive a usable database implementation.

Do not add an Electron-specific `postinstall` script to this library. A library cannot know the consuming application's Electron version, ABI, architecture, or packaging system. Document that the Electron host should use its packaging tool's native dependency handling or `@electron/rebuild`.

### 3.4 Exported-symbol meaning

For this remediation, `exported` means that a parsed declaration is exposed from the current module through:

- an `export` or `default` modifier on the declaration;
- an `export` modifier on the containing `VariableStatement`; or
- a local export list such as `export { refreshTree }`.

Preserve the existing treatment of members inside exported classes to avoid an unrelated metadata contract change. A future change may distinguish public, protected, and private member reachability.

### 3.5 Graph optimization

Apply obvious no-work avoidance now, but defer an affected-subgraph redesign until benchmark data demonstrates that it is needed.

The immediate correctness release must not be blocked by an unmeasured graph rewrite.

## 4. Workstream A — replace `node:sqlite`

### A1. Dependency and compiler changes

Files:

- `package.json`
- `package-lock.json`

Changes:

1. Add a current Node 22-compatible `better-sqlite3` release to `dependencies`.
2. Add `@types/better-sqlite3` to `devDependencies` if the selected release does not provide sufficient declarations.
3. Retain the current Node engine floor unless installation testing proves a higher floor is required.
4. Regenerate the lockfile with a clean package-manager install.
5. Verify that optional Xberg dependencies remain optional and are not affected by the storage change.

The package should not expose `better-sqlite3` types from its public API.

### A2. Port `SqliteStore`

File:

- `src/storage/sqlite-store.ts`

Changes:

1. Replace the `node:sqlite` import with the `better-sqlite3` constructor and database type.
2. Open `:memory:` and file-backed databases using the existing storage-path behavior.
3. Preserve the 5-second busy timeout.
4. Preserve:
   - foreign key enforcement;
   - WAL mode for file-backed databases;
   - normal synchronous mode;
   - strict tables;
   - prepared parameter binding;
   - explicit transaction boundaries;
   - synchronous store methods.
5. Keep returned integers as JavaScript numbers. Do not enable safe-integer/BigInt mode unless the complete API is updated and tested for it.
6. Confirm that `.run()`, `.get()`, `.all()`, and `.exec()` result handling matches every existing call site.
7. Preserve `close()` idempotency expectations at the `CodeIndex` layer.

### A3. Add an FTS5 capability probe

File:

- `src/storage/sqlite-store.ts`

Implementation:

1. Run a real FTS5 virtual-table probe before creating the package schema.
2. Use a uniquely named temporary probe table.
3. Drop the probe immediately after successful creation.
4. If creation fails, close the database and throw an error that includes:
   - that FTS5 is required;
   - which storage backend was loaded;
   - the original SQLite error as `cause`;
   - Electron rebuild guidance where relevant.
5. Do not rely only on `PRAGMA compile_options`; successful virtual-table creation is the capability that matters.

### A4. Verify schema compatibility

Files:

- `src/storage/sqlite-store.ts`
- `test/core.test.mjs`

Checks:

1. A database partially initialized by the failing `node:sqlite` implementation can be reopened and completed.
2. A database created by the replacement backend can be closed and reopened without reindexing unchanged files.
3. FTS rows remain synchronized when a file is replaced, removed, or the index is reset.
4. Existing schema version `1` remains valid if the SQL schema is unchanged.
5. If backend differences require a schema change, increment the schema version and implement an explicit migration before release.

### A5. Storage-specific tests

Add:

- `test/storage.test.mjs`

Test cases:

1. Construct an in-memory store and create an FTS5 table.
2. Insert a document and retrieve it through `MATCH`.
3. Replace a file and verify old FTS content is absent.
4. Remove a file and verify relational and FTS content is absent.
5. Reset and verify all index-owned data is cleared.
6. Open, close, and reopen a file-backed database.
7. Assert that a backend capability failure reports an actionable error where the failure can be injected reliably.

Exit criteria:

- `createCodeIndex()` succeeds on stock Node 22.
- Existing core, watch, and worker tests pass.
- Lexical search returns indexed source text.

## 5. Workstream B — reliable worker startup

### B1. Define internal worker protocol messages

Files:

- `src/worker-host.ts`
- `src/worker-client.ts`

Define internal discriminated message shapes for:

- `ready`;
- `startup-error`;
- `event`;
- `response`;
- request messages.

The serialized error payload should include:

- `name`;
- `message`;
- `stack`, when available;
- `code`, when available.

These are internal types and do not need to become public package exports.

### B2. Guard host initialization

File:

- `src/worker-host.ts`

Changes:

1. Validate `parentPort`.
2. Construct `CodeIndex` inside a `try/catch`.
3. Register event forwarding only after construction succeeds.
4. Send `ready` after the index and message handler are ready to accept requests.
5. On failure:
   - serialize and post `startup-error`;
   - do not install a request handler;
   - close the worker port after the message has been queued.
6. Continue using structured response errors for failures that occur after startup.

An error while loading the worker module or native addon can occur before the guarded constructor runs. The client-side `error` event must therefore remain a first-class startup failure path.

### B3. Add client readiness and terminal failure state

File:

- `src/worker-client.ts`

Changes:

1. Create a startup promise when the worker is created.
2. Resolve it only after receiving `ready`.
3. Reject it on:
   - `startup-error`;
   - worker `error`;
   - non-zero exit before readiness.
4. Store the first terminal failure in a private field.
5. Make every operation await readiness before posting its request.
6. Reject future operations immediately with the stored startup error.
7. Ensure an exit event cannot overwrite a more specific startup error.
8. Reject all pending calls exactly once.
9. Make `close()` safe:
   - before readiness;
   - after startup failure;
   - during normal operation;
   - when called repeatedly.
10. Preserve the original stack and error code when reconstructing a serialized error.

### B4. Worker regression tests

File:

- `test/worker.test.mjs`

Add cases for:

1. successful readiness followed by indexing and search;
2. invalid storage path at construction;
3. the first call receiving the original startup message rather than an exit-code error;
4. later calls rejecting immediately with the same terminal cause;
5. close after failed startup;
6. unknown worker method remaining a normal response error, if tested through an internal fixture.

Exit criteria:

- No startup failure is reported only as `worker exited with code 1`.
- No request can remain pending after a worker startup failure or exit.

## 6. Workstream C — correct TypeScript export metadata

### C1. Collect module export information

File:

- `src/parser/typescript-provider.ts`

Changes:

1. Add a helper that finds the declaration carrying export modifiers.
2. For `VariableDeclaration`, inspect its enclosing `VariableStatement`.
3. Before symbol emission, collect locally exported names from:
   - `export { name }`;
   - aliased exports such as `export { localName as publicName }`;
   - identifier-based default export assignments where applicable.
4. Do not mark a declaration for a re-export sourced from another module, such as `export { value } from './other.js'`, because there is no local declaration to annotate.
5. Determine `exported` from declaration modifiers, enclosing variable-statement modifiers, collected local export names, and the existing exported-container behavior.
6. Keep parser traversal deterministic and avoid introducing TypeScript type-checker or project-program construction.

### C2. Parser unit coverage

Add:

- `test/typescript-provider.test.mjs`

Cases:

- `export const arrow = () => 1`;
- `export const expression = function () {}`;
- `export let value = 1`;
- `const local = () => 1`;
- `const listed = () => 1; export { listed };`;
- `const local = () => 1; export { local as renamed };`;
- `export function declared() {}`;
- `export default class Named {}`;
- exported and non-exported class members, preserving current semantics;
- re-export from another module not creating or incorrectly marking a local symbol.

Add at least one end-to-end assertion to `test/core.test.mjs` so persisted `SymbolRecord.exported` is also verified.

Exit criteria:

- Modern exported variable declarations are persisted with `exported: true`.
- Non-exported declarations remain false.

## 7. Workstream D — search wildcard correctness

### D1. Escape `LIKE` patterns

Files:

- `src/storage/sqlite-store.ts`
- optionally `src/util/text.ts` if the helper is shared

Changes:

1. Add a helper that escapes `\`, `%`, and `_` for SQL `LIKE`.
2. Add `ESCAPE '\'` to partial symbol and path queries.
3. Continue binding all query values as parameters.
4. Do not change exact symbol matching.

### D2. Tests

Add search fixtures containing:

- names and paths with underscores;
- literal percent characters where supported by the tokenization path;
- backslashes at the store-query level;
- nearby names that would match only if `_` were treated as a wildcard.

Exit criteria:

- User tokens are interpreted literally by symbol and path substring search.

## 8. Workstream E — avoid unnecessary graph rebuilds

### E1. Immediate no-work optimization

File:

- `src/code-index.ts`

Changes:

1. In `indexFile()`, rebuild the graph only for `indexed` or `fallback`.
2. Do not rebuild after `unchanged` or `skipped`.
3. Keep one graph rebuild after a watcher debounce batch, not one per changed path.
4. Review `removeFile()` behavior against `graph.resolveOnIndex` and make it consistent with documented configuration.
5. Add tests that instrument or otherwise observe graph rebuilding without exposing test-only public APIs.

### E2. Benchmark harness

Add:

- `benchmark/graph-update.mjs`
- a documented npm script such as `benchmark:graph`

The harness should generate deterministic repositories at multiple sizes and report:

- initial indexing duration;
- graph rebuild duration;
- unchanged `indexFile()` duration;
- changed single-file update duration;
- watcher burst duration;
- file, symbol, import, reference, and edge counts;
- peak process memory where practical.

Suggested fixture sizes:

- small: 100 files;
- medium: 2,000 files;
- large: 10,000 files.

Do not make benchmark timing assertions part of the normal unit test suite. Store machine-readable results so changes can be compared on the same hardware.

### E3. Decision gate for incremental graph updates

Implement affected-subgraph updates only if the benchmark exceeds the product's agreed responsiveness budget.

Before implementing, define budgets for:

- p95 single-file save-to-index completion;
- maximum worker CPU occupancy during active editing;
- maximum acceptable graph rebuild duration;
- memory growth relative to repository size.

If required, the incremental design should:

1. identify edges whose source file is changed or removed;
2. recalculate imports and references from that source;
3. recalculate incoming heuristic/resolved edges whose target candidates changed;
4. update affected edges transactionally;
5. periodically run a complete graph reconciliation as a correctness backstop.

The full rebuild path should remain available for initial indexing, reset, explicit reconciliation, and recovery.

## 9. Workstream F — documentation and package delivery

### F1. Correct runtime and storage documentation

Files:

- `README.md`
- `IMPLEMENTATION_PLAN.md`
- `examples/electron-main.ts`

Changes:

1. Replace claims that persistence uses built-in `node:sqlite`.
2. State that FTS5 is supplied by `better-sqlite3`.
3. Explain that the dependency is native.
4. Document Electron integration options:
   - Electron Forge native dependency handling;
   - an Electron-compatible prebuild when available;
   - `@electron/rebuild` when rebuilding is required.
5. Warn against rebuilding the dependency for system Node and then loading that binary in an ABI-incompatible Electron runtime.
6. Keep the recommendation to run indexing in the Electron main process, utility process, or a worker—not a sandboxed renderer.
7. Add error guidance for:
   - missing native binary;
   - module ABI mismatch;
   - unsupported architecture;
   - missing FTS5 capability.

### F2. Correct implementation-status claims

File:

- `IMPLEMENTATION_PLAN.md`

Changes:

1. Update the persistence architecture decision.
2. Remove the obsolete “possible later adapter” framing.
3. Mark tests as verified only after the minimum-runtime matrix passes.
4. Record the known full-graph rebuild characteristic and benchmark gate.
5. Update desktop acceptance criteria to include packaged Electron startup and lexical search.

### F3. Package inspection

Run and inspect:

- `npm pack --dry-run`;
- installation from the generated tarball into a clean Node fixture;
- import from ESM;
- TypeScript declaration consumption;
- native dependency installation on supported platforms.

The tarball must include only intended package files. The installed dependency must not rely on this repository's development environment.

## 10. Verification matrix

### Required Node verification

Run on:

- minimum declared Node version;
- latest Node 22 patch;
- current Node LTS supported by the package.

For each runtime:

1. clean install;
2. build;
3. typecheck;
4. full tests;
5. package dry run;
6. tarball consumer smoke test.

### Required platform verification

At minimum:

- macOS arm64;
- Linux x64;
- Windows x64.

Add other architectures supported by the target desktop product when CI capacity exists.

### Electron verification

Use the product's actual Electron version, not system Node.

Test:

1. unpackaged development start;
2. packaged application start;
3. worker startup;
4. file-backed database creation under user data;
5. index and lexical search;
6. application restart and database reopen;
7. native module loading on every shipping architecture.

## 11. Delivery sequence

### Change set 1 — restore core usability

Scope:

- Workstream A;
- storage tests;
- minimum README storage/runtime corrections.

Gate:

- core tests pass on stock Node 22;
- FTS lexical search works;
- package can be installed from its tarball.

### Change set 2 — worker startup reliability

Scope:

- Workstream B.

Gate:

- startup errors preserve their original cause;
- no hanging calls after startup failure.

### Change set 3 — metadata and query correctness

Scope:

- Workstream C;
- Workstream D.

Gate:

- parser and end-to-end export tests pass;
- wildcard tests pass.

### Change set 4 — graph no-work optimization and measurement

Scope:

- Workstream E1;
- benchmark harness from E2.

Gate:

- unchanged updates do not rebuild the graph;
- benchmark results are reproducible and recorded.

### Change set 5 — release documentation and Electron validation

Scope:

- Workstream F;
- Node/platform/Electron verification matrix.

Gate:

- documentation matches observed behavior;
- the packaged target Electron application passes startup and lexical-search smoke tests.

An affected-subgraph implementation, if justified by measurements, should be a separate change after Change set 4.

## 12. Definition of done

All of the following must be true:

- `npm test` passes on the minimum declared stock Node runtime.
- `npm run typecheck` passes.
- `npm run pack:check` passes.
- FTS5 lexical retrieval works without a custom Node build.
- Direct and worker APIs produce equivalent successful results.
- Worker startup failures preserve the original error.
- Exported variable declarations are labeled correctly.
- SQL `LIKE` metacharacters are treated literally.
- An unchanged direct file update does not rebuild the graph.
- Existing database reopen and persistence behavior remains covered.
- Electron native-module preparation is documented and validated in the target application.
- README and implementation-status claims describe tested behavior, not intended behavior.

## 13. Out of scope

The remediation does not include:

- vector search or embeddings;
- a public pluggable storage API;
- simultaneous maintenance of `node:sqlite` and `better-sqlite3`;
- a universal type-aware call graph;
- changing Xberg's parser distribution policy;
- affected-subgraph graph updates without benchmark justification;
- running repository indexing in a sandboxed Electron renderer.

