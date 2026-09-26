export function computeLineByteOffsets(buffer: Buffer): number[] {
  const offsets = [0];
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 10) offsets.push(i + 1);
  }
  return offsets;
}

export function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./\\:-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function queryTokens(query: string): string[] {
  return [...new Set(splitIdentifier(query).concat(
    query.toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter((token) => token.length > 1),
  ))].slice(0, 16);
}

export function toSafeFtsQuery(query: string): string | undefined {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

export function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let suspicious = 0;
  const length = Math.min(buffer.length, 8192);
  for (let i = 0; i < length; i += 1) {
    const byte = buffer[i]!;
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / length > 0.3;
}

export function createLineChunks(content: string, chunkLines: number, overlapLines: number): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  const size = Math.max(1, chunkLines);
  const overlap = Math.min(Math.max(0, overlapLines), size - 1);
  const step = size - overlap;
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  for (let start = 0; start < lines.length; start += step) {
    const endExclusive = Math.min(lines.length, start + size);
    chunks.push({
      startLine: start + 1,
      endLine: endExclusive,
      text: lines.slice(start, endExclusive).join('\n'),
    });
    if (endExclusive === lines.length) break;
  }
  return chunks;
}
