import type { NormalizedCodeIndexConfig, ParsedSyntax, SyntaxProvider, SyntaxProviderInput } from '../types.js';
import { GenericSyntaxProvider } from './generic-provider.js';
import { TypeScriptSyntaxProvider } from './typescript-provider.js';
import { XbergSyntaxProvider } from './xberg-provider.js';

export class CompositeSyntaxProvider {
  readonly providers: SyntaxProvider[];
  readonly fallback = new GenericSyntaxProvider();

  constructor(private readonly config: NormalizedCodeIndexConfig) {
    const providers: SyntaxProvider[] = [...config.syntaxProviders];
    providers.push(new TypeScriptSyntaxProvider());
    if (config.xberg.enabled) providers.push(new XbergSyntaxProvider(config.xberg.languages));
    this.providers = providers;
  }

  async parse(input: SyntaxProviderInput): Promise<{ syntax: ParsedSyntax; fallback: boolean; error?: Error }> {
    let lastError: Error | undefined;
    for (const provider of this.providers) {
      let supported = false;
      try {
        supported = await provider.supports(input);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (!supported) continue;
      try {
        return { syntax: await provider.parse(input), fallback: false };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.config.logger.warn?.('Syntax provider failed; trying the next provider', {
          filePath: input.relativePath,
          provider: provider.name,
          error: lastError.message,
        });
        if (provider.name === 'xberg-tree-sitter-language-pack' && !this.config.xberg.fallBackOnError) throw lastError;
      }
    }
    return { syntax: this.fallback.parse(input), fallback: true, error: lastError };
  }
}
