import { execFile } from 'node:child_process';
import { opendir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { matchesGlob } from './util/glob.js';
import { promisify } from 'node:util';
import type { NormalizedCodeIndexConfig } from './types.js';
import { normalizeRelativePath } from './util/path.js';
import { isProbablyBinary } from './util/text.js';

const execFileAsync = promisify(execFile);

function matchesAny(relativePath: string, globs: string[]): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return globs.some((glob) => matchesGlob(normalized, glob) || matchesGlob(`/${normalized}`, glob));
}

export function isPathIncluded(relativePath: string, config: NormalizedCodeIndexConfig): boolean {
  if (matchesAny(relativePath, config.discovery.ignoreGlobs)) return false;
  if (config.discovery.includeGlobs.length === 0) return true;
  return matchesAny(relativePath, config.discovery.includeGlobs);
}

async function discoverWithGit(config: NormalizedCodeIndexConfig, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: config.workspaceRoot,
    encoding: 'buffer',
    maxBuffer: config.discovery.gitMaxBufferBytes,
    signal,
  });
  return stdout.toString('utf8').split('\0').filter(Boolean).map(normalizeRelativePath);
}

async function discoverWithFilesystem(config: NormalizedCodeIndexConfig, signal?: AbortSignal): Promise<DiscoveryResult> {
  const files: string[] = [];
  let ignored = 0;
  const walk = async (directory: string): Promise<void> => {
    if (signal?.aborted) return;
    const dir = await opendir(directory);
    for await (const entry of dir) {
      if (signal?.aborted) return;
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(config.workspaceRoot, absolute));
      if (entry.isSymbolicLink() && !config.discovery.followSymlinks) continue;
      if (entry.isDirectory()) {
        if (matchesAny(`${relative}/x`, config.discovery.ignoreGlobs) || matchesAny(relative, config.discovery.ignoreGlobs)) continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        if (isPathIncluded(relative, config)) files.push(relative);
        else ignored += 1;
      }
    }
  };
  await walk(config.workspaceRoot);
  return { files, ignored };
}

export interface DiscoveryResult {
  files: string[];
  ignored: number;
}

function partitionIncluded(paths: string[], config: NormalizedCodeIndexConfig): DiscoveryResult {
  const files: string[] = [];
  let ignored = 0;
  for (const relativePath of paths) {
    if (isPathIncluded(relativePath, config)) files.push(relativePath);
    else ignored += 1;
  }
  return { files, ignored };
}

export async function discoverFiles(config: NormalizedCodeIndexConfig, signal?: AbortSignal): Promise<DiscoveryResult> {
  if (config.discovery.mode !== 'filesystem') {
    try {
      return partitionIncluded(await discoverWithGit(config, signal), config);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (config.discovery.mode === 'git') throw error;
      config.logger.debug?.('Git discovery unavailable; using filesystem walk', { error: String(error) });
    }
  }
  return discoverWithFilesystem(config, signal);
}

export interface ReadableSourceFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
  buffer: Buffer;
  content: string;
}

export async function readSourceFile(relativePath: string, config: NormalizedCodeIndexConfig): Promise<ReadableSourceFile | undefined> {
  const absolutePath = path.resolve(config.workspaceRoot, relativePath);
  if (!absolutePath.startsWith(`${config.workspaceRoot}${path.sep}`) && absolutePath !== config.workspaceRoot) return undefined;
  let metadata;
  try { metadata = await stat(absolutePath); } catch { return undefined; }
  if (!metadata.isFile() || metadata.size > config.discovery.maxFileBytes) return undefined;
  const buffer = await readFile(absolutePath);
  const probe = buffer.subarray(0, Math.min(buffer.length, config.discovery.binaryProbeBytes));
  if (isProbablyBinary(probe)) return undefined;
  return {
    relativePath: normalizeRelativePath(relativePath), absolutePath, sizeBytes: metadata.size,
    mtimeMs: metadata.mtimeMs, buffer, content: buffer.toString('utf8'),
  };
}
