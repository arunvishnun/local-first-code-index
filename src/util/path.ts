import path from 'node:path';

export function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

export function fileNodeId(relativePath: string): string {
  return `file:${normalizeRelativePath(relativePath)}`;
}

export function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
