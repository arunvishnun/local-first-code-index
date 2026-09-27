import path from 'node:path';
import type { CodeIndexConfig, Logger, NormalizedCodeIndexConfig } from './types.js';

const noopLogger: Logger = {};

export const DEFAULT_EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.py': 'python', '.pyw': 'python', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.cs': 'csharp', '.fs': 'fsharp', '.fsx': 'fsharp', '.vb': 'visualbasic',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.scala': 'scala', '.sc': 'scala',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh', '.fish': 'fish', '.ps1': 'powershell',
  '.lua': 'lua', '.pl': 'perl', '.pm': 'perl', '.r': 'r', '.R': 'r', '.dart': 'dart',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hrl': 'erlang', '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure',
  '.hs': 'haskell', '.lhs': 'haskell', '.ml': 'ocaml', '.mli': 'ocaml', '.nim': 'nim', '.zig': 'zig',
  '.vue': 'vue', '.svelte': 'svelte', '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.json': 'json', '.jsonc': 'jsonc', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.ini': 'ini', '.properties': 'properties',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'proto', '.tf': 'hcl', '.hcl': 'hcl',
  '.md': 'markdown', '.mdx': 'mdx', '.rst': 'rst', '.tex': 'latex',
  '.gradle': 'groovy', '.groovy': 'groovy', '.sol': 'solidity', '.move': 'move', '.v': 'v', '.vala': 'vala',
  '.asm': 'assembly', '.s': 'assembly', '.wat': 'wat', '.wasm': 'binary',
};

const defaultIgnoreGlobs = [
  '**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**',
  '**/.next/**', '**/.turbo/**', '**/.cache/**', '**/.local-code-index/**', '**/target/**',
  '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/.idea/**', '**/.vscode/**',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
];

export function normalizeConfig(config: CodeIndexConfig): NormalizedCodeIndexConfig {
  const workspaceRoot = path.resolve(config.workspaceRoot);
  const storagePath = config.storagePath === ':memory:'
    ? ':memory:'
    : path.resolve(config.storagePath ?? path.join(workspaceRoot, '.local-code-index', 'index.sqlite'));

  return {
    workspaceRoot,
    storagePath,
    watch: {
      enabled: config.watch?.enabled ?? false,
      debounceMs: config.watch?.debounceMs ?? 150,
      reconcileIntervalMs: config.watch?.reconcileIntervalMs ?? 300_000,
    },
    discovery: {
      mode: config.discovery?.mode ?? 'auto',
      includeGlobs: config.discovery?.includeGlobs ?? ['**/*'],
      ignoreGlobs: [...defaultIgnoreGlobs, ...(config.discovery?.ignoreGlobs ?? [])],
      maxFileBytes: config.discovery?.maxFileBytes ?? 2 * 1024 * 1024,
      binaryProbeBytes: config.discovery?.binaryProbeBytes ?? 8192,
      followSymlinks: config.discovery?.followSymlinks ?? false,
      gitMaxBufferBytes: config.discovery?.gitMaxBufferBytes ?? 64 * 1024 * 1024,
    },
    chunks: {
      lines: config.chunks?.lines ?? 80,
      overlapLines: config.chunks?.overlapLines ?? 10,
    },
    graph: {
      enabled: config.graph?.enabled ?? true,
      resolveOnIndex: config.graph?.resolveOnIndex ?? true,
      includeDirectCalls: config.graph?.includeDirectCalls ?? true,
    },
    search: {
      defaultLimit: config.search?.defaultLimit ?? 20,
      rrfK: config.search?.rrfK ?? 60,
      lexicalWeight: config.search?.lexicalWeight ?? 1,
      symbolWeight: config.search?.symbolWeight ?? 1.4,
      pathWeight: config.search?.pathWeight ?? 0.8,
      graphWeight: config.search?.graphWeight ?? 0.7,
      proximityWeight: config.search?.proximityWeight ?? 0.02,
      moduleWeight: config.search?.moduleWeight ?? 0.008,
      graphDepth: config.search?.graphDepth ?? 1,
      graphSeedLimit: config.search?.graphSeedLimit ?? 6,
    },
    context: {
      defaultMaxTokens: config.context?.defaultMaxTokens ?? 6000,
      charsPerToken: config.context?.charsPerToken ?? 4,
      linesBefore: config.context?.linesBefore ?? 3,
      linesAfter: config.context?.linesAfter ?? 3,
      verifyFreshness: config.context?.verifyFreshness ?? true,
      budget: {
        maxFiles: config.context?.budget?.maxFiles ?? 6,
        maxSnippets: config.context?.budget?.maxSnippets ?? 8,
        maxLines: config.context?.budget?.maxLines ?? 240,
        maxBytes: config.context?.budget?.maxBytes ?? 24_000,
        maxEstimatedTokens: config.context?.budget?.maxEstimatedTokens ?? config.context?.defaultMaxTokens ?? 4_000,
        maxGraphDepth: config.context?.budget?.maxGraphDepth ?? 1,
      },
    },
    fallbackSearch: {
      enabled: config.fallbackSearch?.enabled ?? true,
      ripgrepPath: config.fallbackSearch?.ripgrepPath ?? 'auto',
      maxFiles: config.fallbackSearch?.maxFiles ?? 500,
      maxBytes: config.fallbackSearch?.maxBytes ?? 8 * 1024 * 1024,
    },
    resources: {
      maxConcurrency: Math.max(1, config.resources?.maxConcurrency ?? 2),
      yieldEveryFiles: Math.max(1, config.resources?.yieldEveryFiles ?? 10),
    },
    xberg: {
      enabled: config.xberg?.enabled ?? false,
      languages: config.xberg?.languages ?? [],
      fallBackOnError: config.xberg?.fallBackOnError ?? true,
    },
    extensionLanguageMap: { ...DEFAULT_EXTENSION_LANGUAGE_MAP, ...(config.extensionLanguageMap ?? {}) },
    syntaxProviders: [...(config.syntaxProviders ?? [])],
    logger: config.logger ?? noopLogger,
  };
}
