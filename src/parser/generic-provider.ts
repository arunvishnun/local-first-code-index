import type { ParsedSyntax, SyntaxProvider, SyntaxProviderInput } from '../types.js';

export class GenericSyntaxProvider implements SyntaxProvider {
  readonly name = 'generic-text';
  supports(): boolean { return true; }
  parse(_input: SyntaxProviderInput): ParsedSyntax {
    return { parser: this.name, symbols: [], imports: [], references: [] };
  }
}
