import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NormalizedCodeIndexConfig, SearchResult } from '../types.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { queryTokens } from '../util/text.js';

const execFileAsync = promisify(execFile);
let cachedRg: string | false | undefined;

async function resolveRipgrep(config: NormalizedCodeIndexConfig): Promise<string | false> {
  const configured = config.fallbackSearch.ripgrepPath;
  if (configured === false) return false;
  if (configured !== 'auto') return configured;
  if (cachedRg !== undefined) return cachedRg;
  try {
    await execFileAsync('rg', ['--version'], { timeout: 1500, maxBuffer: 1024 * 1024 });
    cachedRg = 'rg';
  } catch {
    cachedRg = false;
  }
  return cachedRg;
}

async function ripgrepSearch(query: string, config: NormalizedCodeIndexConfig, limit: number): Promise<SearchResult[] | undefined> {
  const command = await resolveRipgrep(config);
  if (!command) return undefined;
  const tokens = queryTokens(query).slice(0, 6);
  if (tokens.length === 0) return [];
  const args = ['--json', '--fixed-strings', '--hidden', '--glob', '!.git/**'];
  for (const token of tokens) args.push('-e', token);
  args.push('.');
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: config.workspaceRoot,
      maxBuffer: Math.max(2 * 1024 * 1024, config.fallbackSearch.maxBytes),
    });
    const results: SearchResult[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'match') continue;
      const rawPath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (typeof rawPath !== 'string' || typeof lineNumber !== 'number') continue;
      const relative = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
      results.push({
        filePath: relative,
        language: 'text',
        score: 1 / (results.length + 1),
        range: { startLine: lineNumber, endLine: lineNumber },
        reasons: [{ source: 'fallback', rank: results.length + 1, contribution: 1 / (results.length + 1) }],
        snippet: typeof event.data?.lines?.text === 'string' ? event.data.lines.text.trimEnd() : undefined,
      });
      if (results.length >= limit) break;
    }
    return results;
  } catch {
    return undefined;
  }
}

async function nodeSearch(query: string, store: SqliteStore, config: NormalizedCodeIndexConfig, limit: number): Promise<SearchResult[]> {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const results: SearchResult[] = [];
  let bytes = 0;
  let files = 0;
  for (const indexed of store.listFiles()) {
    if (files >= config.fallbackSearch.maxFiles || bytes >= config.fallbackSearch.maxBytes) break;
    const absolute = path.join(config.workspaceRoot, indexed.path);
    let buffer: Buffer;
    try { buffer = await readFile(absolute); } catch { continue; }
    files += 1;
    bytes += buffer.length;
    const content = buffer.toString('utf8');
    const lower = content.toLowerCase();
    const found = tokens.find((token) => lower.includes(token));
    if (!found) continue;
    const index = lower.indexOf(found);
    const line = content.slice(0, index).split(/\r?\n/).length;
    const lineText = content.split(/\r?\n/)[line - 1] ?? '';
    results.push({
      filePath: indexed.path,
      language: indexed.language,
      score: 1 / (results.length + 1),
      range: { startLine: line, endLine: line },
      reasons: [{ source: 'fallback', rank: results.length + 1, contribution: 1 / (results.length + 1) }],
      snippet: lineText,
    });
    if (results.length >= limit) break;
  }
  return results;
}

export async function fallbackSearch(query: string, store: SqliteStore, config: NormalizedCodeIndexConfig, limit: number): Promise<SearchResult[]> {
  const rg = await ripgrepSearch(query, config, limit);
  if (rg !== undefined) return rg;
  return nodeSearch(query, store, config, limit);
}
