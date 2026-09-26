import type { ParsedImport, ParsedSymbol, ParsedSyntax, SymbolKind, SyntaxProvider, SyntaxProviderInput } from '../types.js';

const PACKAGE_NAME = '@xberg-io/tree-sitter-language-pack';

type XbergModule = {
  process(source: string, config: Record<string, unknown>): unknown;
};

function mapKind(value: unknown): SymbolKind {
  const raw = typeof value === 'string' ? value.toLowerCase() : String(value ?? '').toLowerCase();
  if (raw.includes('function')) return 'function';
  if (raw.includes('method')) return 'method';
  if (raw.includes('class')) return 'class';
  if (raw.includes('interface') || raw.includes('protocol')) return 'interface';
  if (raw.includes('struct')) return 'struct';
  if (raw.includes('enum')) return 'enum';
  if (raw.includes('trait')) return 'trait';
  if (raw.includes('impl')) return 'impl';
  if (raw.includes('namespace')) return 'namespace';
  if (raw.includes('module')) return 'module';
  return 'other';
}

function numberField(object: Record<string, unknown>, camel: string, snake: string): number | undefined {
  const value = object[camel] ?? object[snake];
  return typeof value === 'number' ? value : undefined;
}

function flattenStructure(items: unknown[], out: ParsedSymbol[]): void {
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : undefined;
    const spanRaw = item.span;
    if (name && spanRaw && typeof spanRaw === 'object') {
      const span = spanRaw as Record<string, unknown>;
      const startLine = numberField(span, 'startLine', 'start_line');
      const endLine = numberField(span, 'endLine', 'end_line');
      if (startLine !== undefined && endLine !== undefined) {
        out.push({
          name,
          kind: mapKind(item.kind),
          startLine: startLine + 1,
          endLine: endLine + 1,
          startColumn: (numberField(span, 'startColumn', 'start_column') ?? 0) + 1,
          endColumn: (numberField(span, 'endColumn', 'end_column') ?? 0) + 1,
          signature: typeof item.signature === 'string' ? item.signature : undefined,
          exported: typeof item.visibility === 'string' ? item.visibility === 'public' || item.visibility === 'pub' : undefined,
        });
      }
    }
    const children = item.children;
    if (Array.isArray(children)) flattenStructure(children, out);
  }
}

export class XbergSyntaxProvider implements SyntaxProvider {
  readonly name = 'xberg-tree-sitter-language-pack';
  #languages?: Set<string>;
  #module?: Promise<XbergModule>;

  constructor(languages?: string[]) {
    this.#languages = languages?.length ? new Set(languages.map((language) => language.toLowerCase())) : undefined;
  }

  supports(input: SyntaxProviderInput): boolean {
    const language = input.language.toLowerCase();
    if (language === 'text' || language === 'binary') return false;
    return !this.#languages || this.#languages.has(language);
  }

  async #load(): Promise<XbergModule> {
    this.#module ??= import(PACKAGE_NAME) as Promise<XbergModule>;
    return this.#module;
  }

  async parse(input: SyntaxProviderInput): Promise<ParsedSyntax> {
    const module = await this.#load();
    const resultRaw = module.process(input.content, {
      language: input.language,
      structure: true,
      imports: true,
      exports: true,
      symbols: true,
      comments: false,
      docstrings: false,
    });
    if (!resultRaw || typeof resultRaw !== 'object') throw new Error('Xberg returned an invalid process result');
    const result = resultRaw as Record<string, unknown>;
    const symbols: ParsedSymbol[] = [];
    if (Array.isArray(result.structure)) flattenStructure(result.structure, symbols);

    const imports: ParsedImport[] = [];
    if (Array.isArray(result.imports)) {
      for (const raw of result.imports) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const specifier = typeof item.source === 'string' ? item.source : undefined;
        if (!specifier) continue;
        const items = Array.isArray(item.items) ? item.items.filter((value): value is string => typeof value === 'string') : [];
        const alias = typeof item.alias === 'string' ? item.alias : undefined;
        if (items.length === 0) imports.push({ specifier, localName: alias });
        else for (const importedName of items) imports.push({ specifier, importedName, localName: items.length === 1 ? alias ?? importedName : importedName });
      }
    }

    return { parser: this.name, symbols, imports, references: [] };
  }
}
