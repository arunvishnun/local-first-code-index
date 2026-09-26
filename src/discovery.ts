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

async function discoverWithGit(config: NormalizedCodeIndexConfig): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: config.workspaceRoot,
    encoding: 'buffer',
    maxBuffer: config.discovery.gitMaxBufferBytes,
  });
  return stdout.toString('utf8').split('\0').filter(Boolean).map(normalizeRelativePath).filter((file) => isPathIncluded(file, config));
}

async function discoverWithFilesystem(config: NormalizedCodeIndexConfig): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const dir = await opendir(directory);
    for await (const entry of dir) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(config.workspaceRoot, absolute));
      if (entry.isSymbolicLink() && !config.discovery.followSymlinks) continue;
      if (entry.isDirectory()) {
        if (matchesAny(`${relative}/x`, config.discovery.ignoreGlobs) || matchesAny(relative, config.discovery.ignoreGlobs)) continue;
        await walk(absolute);
      } else if (entry.isFile() && isPathIncluded(relative, config)) {
        files.push(relative);
      }
    }
  };
  await walk(config.workspaceRoot);
  return files;
}

export async function discoverFiles(config: NormalizedCodeIndexConfig): Promise<string[]> {
  if (config.discovery.mode !== 'filesystem') {
    try {
      return await discoverWithGit(config);
    } catch (error) {
      if (config.discovery.mode === 'git') throw error;
      config.logger.debug?.('Git discovery unavailable; using filesystem walk', { error: String(error) });
    }
  }
  return discoverWithFilesystem(config);
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
