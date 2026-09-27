const TEST_MARKER = /\.(?:test|spec)(?=\.[^.]+$)/;

export function isTestFile(filePath: string): boolean {
  return TEST_MARKER.test(filePath);
}

export function candidateSourcePaths(testPath: string): string[] {
  if (!isTestFile(testPath)) return [];
  const direct = testPath.replace(TEST_MARKER, '');
  const results = [direct];
  if (direct.includes('/__tests__/')) results.push(direct.replace('/__tests__/', '/'));
  return results;
}

export function candidateTestPaths(sourcePath: string): string[] {
  if (isTestFile(sourcePath)) return [];
  const dot = sourcePath.lastIndexOf('.');
  if (dot <= 0) return [];
  const stem = sourcePath.slice(0, dot);
  const extension = sourcePath.slice(dot);
  return [`${stem}.test${extension}`, `${stem}.spec${extension}`];
}
