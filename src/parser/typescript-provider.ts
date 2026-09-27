import * as ts from 'typescript';
import type { ParsedImport, ParsedReference, ParsedSymbol, ParsedSyntax, SymbolKind, SymbolRole, SyntaxProvider, SyntaxProviderInput } from '../types.js';

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function isTopLevelDeclaration(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node)) return ts.isSourceFile(node.parent.parent.parent);
  return ts.isSourceFile(node.parent);
}

function isDeclarationExported(node: ts.Node, exportedNames: Set<string>, name: string): boolean {
  if (isExported(node) || (isTopLevelDeclaration(node) && exportedNames.has(name))) return true;
  if (ts.isVariableDeclaration(node)) {
    const declarationList = node.parent;
    const statement = declarationList.parent;
    if (ts.isVariableStatement(statement) && isExported(statement)) return true;
  }
  return node.parent ? isExported(node.parent) : false;
}

function collectLocalExportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.propertyName?.text ?? element.name.text);
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function rangeOf(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number; startColumn: number; endColumn: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    endLine: end.line + 1,
    startColumn: start.character + 1,
    endColumn: end.character + 1,
  };
}

function signatureOf(sourceFile: ts.SourceFile, node: ts.Node): string | undefined {
  const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const bodyStart = text.indexOf('{');
  const arrowStart = text.indexOf('=>');
  const cut = bodyStart >= 0 ? bodyStart : arrowStart >= 0 ? arrowStart + 2 : text.length;
  return text.slice(0, Math.min(cut, 320)).trim();
}

function namedSymbol(sourceFile: ts.SourceFile, node: ts.Node): { name: string; kind: SymbolKind } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.text, kind: 'function' };
  if (ts.isClassDeclaration(node) && node.name) return { name: node.name.text, kind: 'class' };
  if (ts.isInterfaceDeclaration(node)) return { name: node.name.text, kind: 'interface' };
  if (ts.isEnumDeclaration(node)) return { name: node.name.text, kind: 'enum' };
  if (ts.isTypeAliasDeclaration(node)) return { name: node.name.text, kind: 'type' };
  if (ts.isModuleDeclaration(node)) return { name: node.name.getText(sourceFile), kind: 'namespace' };
  if (ts.isMethodDeclaration(node) && node.name) return { name: node.name.getText(sourceFile), kind: 'method' };
  if (ts.isConstructorDeclaration(node)) return { name: 'constructor', kind: 'constructor' };
  if (ts.isPropertyDeclaration(node) && node.name) return { name: node.name.getText(sourceFile), kind: 'property' };
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return { name: node.name.text, kind: 'function' };
    return { name: node.name.text, kind: 'variable' };
  }
  return undefined;
}

function isJsxFile(input: SyntaxProviderInput): boolean {
  return input.language === 'tsx' || /\.[jt]sx$/i.test(input.filePath);
}

function roleFor(name: string, kind: SymbolKind, input: SyntaxProviderInput): SymbolRole | undefined {
  if (kind === 'function' && /^use[A-Z0-9]/.test(name)) return 'hook';
  if (isJsxFile(input) && kind === 'function' && /^[A-Z]/.test(name)) return 'component';
  return undefined;
}

function scriptKindFor(language: string, filePath: string): ts.ScriptKind {
  if (language === 'tsx' || filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (language === 'typescript' || /\.(ts|mts|cts)$/.test(filePath)) return ts.ScriptKind.TS;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.json')) return ts.ScriptKind.JSON;
  return ts.ScriptKind.JS;
}

export class TypeScriptSyntaxProvider implements SyntaxProvider {
  readonly name = 'typescript-compiler';

  supports(input: SyntaxProviderInput): boolean {
    return ['typescript', 'tsx', 'javascript'].includes(input.language) || /\.(?:[mc]?[jt]sx?)$/i.test(input.filePath);
  }

  parse(input: SyntaxProviderInput): ParsedSyntax {
    const sourceFile = ts.createSourceFile(
      input.filePath,
      input.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(input.language, input.filePath),
    );

    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const references: ParsedReference[] = [];
    const symbolStack: string[] = [];
    const exportedNames = collectLocalExportNames(sourceFile);

    const visit = (node: ts.Node): void => {
      let pushed = false;
      const named = namedSymbol(sourceFile, node);
      if (named) {
        const role = roleFor(named.name, named.kind, input);
        symbols.push({
          ...rangeOf(sourceFile, node),
          name: named.name,
          kind: named.kind,
          signature: signatureOf(sourceFile, node),
          exported: isDeclarationExported(node, exportedNames, named.name),
          ...(role ? { role } : {}),
        });
        symbolStack.push(named.name);
        pushed = true;
      }

      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!clause) {
          imports.push({ specifier });
        } else {
          if (clause.name) {
            imports.push({ specifier, importedName: 'default', localName: clause.name.text, isTypeOnly: clause.isTypeOnly });
          }
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            imports.push({ specifier, importedName: '*', localName: bindings.name.text, isTypeOnly: clause.isTypeOnly });
          } else if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              imports.push({
                specifier,
                importedName: element.propertyName?.text ?? element.name.text,
                localName: element.name.text,
                isTypeOnly: clause.isTypeOnly || element.isTypeOnly,
              });
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        let targetName: string | undefined;
        if (ts.isIdentifier(node.expression)) targetName = node.expression.text;
        else if (ts.isPropertyAccessExpression(node.expression)) targetName = node.expression.name.text;
        if (targetName) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
          references.push({
            sourceSymbolName: symbolStack.at(-1),
            targetName,
            kind: 'call',
            line: pos.line + 1,
            column: pos.character + 1,
          });
        }
      }

      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(tag.getStart(sourceFile));
          references.push({
            sourceSymbolName: symbolStack.at(-1),
            targetName: tag.text,
            kind: 'reference',
            line: pos.line + 1,
            column: pos.character + 1,
          });
        }
      }

      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        const sourceSymbolName = node.name?.text;
        for (const heritage of node.heritageClauses ?? []) {
          const kind = heritage.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
          for (const type of heritage.types) {
            const targetName = type.expression.getText(sourceFile).split('.').at(-1);
            if (targetName) {
              const pos = sourceFile.getLineAndCharacterOfPosition(type.expression.getStart(sourceFile));
              references.push({ sourceSymbolName, targetName, kind, line: pos.line + 1, column: pos.character + 1 });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
      if (pushed) symbolStack.pop();
    };

    visit(sourceFile);

    return { parser: this.name, symbols, imports, references };
  }
}
