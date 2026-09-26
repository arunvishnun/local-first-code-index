import { app } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkerCodeIndex } from 'local-first-code-index';

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

export async function buildAgentContext(index: Awaited<ReturnType<typeof openRepositoryIndex>>, prompt: string) {
  const results = await index.search(prompt, { limit: 12, expandGraph: true });
  const context = await index.getContext({ results, maxTokens: 6_000 });

  return {
    retrievalResults: results,
    sourceContext: context.snippets.map((snippet) => ({
      file: snippet.filePath,
      lines: `${snippet.range.startLine}-${snippet.range.endLine}`,
      content: snippet.content,
    })),
    telemetry: {
      estimatedTokens: context.estimatedTokens,
      bytesRead: context.bytesRead,
      truncated: context.truncated,
    },
  };
}
