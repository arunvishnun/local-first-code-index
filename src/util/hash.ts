import { createHash } from 'node:crypto';

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableId(...parts: Array<string | number | undefined>): string {
  return createHash('sha1').update(parts.map((part) => String(part ?? '')).join('\u0000')).digest('hex');
}
