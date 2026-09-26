import path from 'node:path';
import type { NormalizedCodeIndexConfig } from './types.js';

const fileNameLanguages: Record<string, string> = {
  'dockerfile': 'dockerfile', 'makefile': 'make', 'gemfile': 'ruby', 'rakefile': 'ruby',
  'cmakelists.txt': 'cmake', 'justfile': 'just', 'procfile': 'procfile',
};

export function detectLanguage(filePath: string, contentPrefix: string, config: NormalizedCodeIndexConfig): string {
  const base = path.basename(filePath).toLowerCase();
  const byName = fileNameLanguages[base];
  if (byName) return byName;
  const extension = path.extname(filePath);
  const mapped = config.extensionLanguageMap[extension] ?? config.extensionLanguageMap[extension.toLowerCase()];
  if (mapped) return mapped;
  const firstLine = contentPrefix.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.startsWith('#!')) {
    if (/\bpython\b/.test(firstLine)) return 'python';
    if (/\b(node|deno|bun)\b/.test(firstLine)) return 'javascript';
    if (/\b(bash|sh|zsh)\b/.test(firstLine)) return 'bash';
    if (/\bruby\b/.test(firstLine)) return 'ruby';
    if (/\bperl\b/.test(firstLine)) return 'perl';
  }
  return 'text';
}
