const cache = new Map<string, RegExp>();

function escapeRegex(char: string): string {
  return /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let regex = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          regex += '(?:.*/)?';
        } else regex += '.*';
      } else regex += '[^/]*';
    } else if (char === '?') regex += '[^/]';
    else if (char === '/') regex += '/';
    else regex += escapeRegex(char);
  }
  regex += '$';
  const compiled = new RegExp(regex);
  cache.set(glob, compiled);
  return compiled;
}

export function matchesGlob(value: string, glob: string): boolean {
  return globToRegExp(glob).test(value.replaceAll('\\', '/'));
}
