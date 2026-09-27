import { app } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkerCodeIndex } from 'local-first-code-index';

// The Electron host must package better-sqlite3 for its own Electron ABI.
// Electron Forge handles native modules; other hosts can use @electron/rebuild.
function repoId(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
}

export async function openRepositoryIndex(workspaceRoot: string) {
  const storagePath = path.join(
    app.getPath('userData'),
    'code-indexes',
    repoId(workspaceRoot),
    'index.sqlite',
  );

  const index = createWorkerCodeIndex({
    workspaceRoot,
    storagePath,
    watch: {
      enabled: true,
      debounceMs: 150,
      reconcileIntervalMs: 5 * 60_000,
    },
    discovery: {
      mode: 'auto',
      maxFileBytes: 2 * 1024 * 1024,
      ignoreGlobs: ['**/generated/**', '**/.output/**'],
    },
    resources: {
      maxConcurrency: 2,
      yieldEveryFiles: 10,
    },
    graph: {
      enabled: true,
      resolveOnIndex: true,
      includeDirectCalls: true,
    },
    context: {
      defaultMaxTokens: 6_000,
      verifyFreshness: true,
    },
    // Keep false for a fully offline/no-parser-download baseline.
    // Turn on only after you decide how parsers are pre-fetched for your product.
    xberg: {
      enabled: false,
      languages: ['python', 'java', 'go', 'rust', 'kotlin', 'swift'],
      fallBackOnError: true,
    },
  });

  index.onEvent((event) => {
    // Forward status to your desktop telemetry/status UI if desired.
    console.debug('[code-index]', event);
  });

  await index.start();
  return index;
}

export async function buildAgentContext(
  index: Awaited<ReturnType<typeof openRepositoryIndex>>,
  prompt: string,
  currentFile?: string,
) {
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
    sourceContext: [...pack.primary, ...pack.related].map((snippet) => ({
      file: snippet.filePath,
      lines: `${snippet.range.startLine}-${snippet.range.endLine}`,
      reason: snippet.reason,
      content: snippet.content,
    })),
    nextCandidates: pack.nextCandidates,
    telemetry: pack.metrics,
  };
}
