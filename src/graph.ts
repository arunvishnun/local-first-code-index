import path from 'node:path';
import * as ts from 'typescript';
import type { GraphEdge, ImportRecord, NormalizedCodeIndexConfig, ReferenceRecord, SymbolRecord } from './types.js';
import { SqliteStore } from './storage/sqlite-store.js';
import { fileNodeId, normalizeRelativePath } from './util/path.js';
import { candidateSourcePaths, isTestFile } from './util/relations.js';

const resolutionExtensions = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py', '.java', '.go', '.rs', '.rb', '.php', '.cs', '.kt', '.swift'];

function resolveRelativeImport(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = normalizeRelativePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
  for (const extension of resolutionExtensions) {
    const candidate = `${base}${extension}`;
    if (fileSet.has(candidate)) return candidate;
  }
  for (const extension of resolutionExtensions.filter(Boolean)) {
    const candidate = `${base}/index${extension}`;
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}


function loadTypeScriptCompilerOptions(workspaceRoot: string): ts.CompilerOptions | undefined {
  const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return undefined;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return undefined;
  return ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath)).options;
}

function resolveTypeScriptImport(
  workspaceRoot: string, fromFile: string, specifier: string, fileSet: Set<string>, compilerOptions: ts.CompilerOptions | undefined,
): string | undefined {
  if (!compilerOptions) return undefined;
  const containingFile = path.join(workspaceRoot, fromFile);
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
  if (!resolved) return undefined;
  const relative = normalizeRelativePath(path.relative(workspaceRoot, resolved));
  if (relative.startsWith('../')) return undefined;
  if (fileSet.has(relative)) return relative;
  const withoutDts = relative.replace(/\.d\.ts$/, '.ts');
  return fileSet.has(withoutDts) ? withoutDts : undefined;
}

export function rebuildGraph(store: SqliteStore, config: NormalizedCodeIndexConfig): void {
  if (!config.graph.enabled) {
    store.replaceEdges([]);
    return;
  }

  const files = store.listFiles();
  const fileSet = new Set(files.map((file) => file.path));
  const symbols = store.allSymbols();
  const imports = store.allImports();
  const references = store.allReferences();
  const symbolsByFileAndName = new Map<string, SymbolRecord[]>();
  const symbolsByName = new Map<string, SymbolRecord[]>();

  for (const symbol of symbols) {
    const fileKey = `${symbol.filePath}\u0000${symbol.name.toLowerCase()}`;
    const globalKey = symbol.name.toLowerCase();
    const byFile = symbolsByFileAndName.get(fileKey) ?? [];
    byFile.push(symbol);
    symbolsByFileAndName.set(fileKey, byFile);
    const global = symbolsByName.get(globalKey) ?? [];
    global.push(symbol);
    symbolsByName.set(globalKey, global);
  }

  const compilerOptions = loadTypeScriptCompilerOptions(config.workspaceRoot);
  const updates: Array<{ id: number; resolvedPath?: string }> = [];
  const importsByLocal = new Map<string, ImportRecord>();
  const edges: GraphEdge[] = [];

  for (const item of imports) {
    const resolvedPath = resolveRelativeImport(item.filePath, item.specifier, fileSet)
      ?? resolveTypeScriptImport(config.workspaceRoot, item.filePath, item.specifier, fileSet, compilerOptions);
    updates.push(resolvedPath ? { id: item.id, resolvedPath } : { id: item.id });
    if (resolvedPath) {
      edges.push({ sourceId: fileNodeId(item.filePath), targetId: fileNodeId(resolvedPath), type: 'imports', confidence: 'exact', filePath: item.filePath });
      if (item.localName) importsByLocal.set(`${item.filePath}\u0000${item.localName.toLowerCase()}`, { ...item, resolvedPath });
    }
  }
  store.updateResolvedImports(updates);

  for (const symbol of symbols) {
    edges.push({ sourceId: fileNodeId(symbol.filePath), targetId: symbol.id, type: 'contains', confidence: 'exact', filePath: symbol.filePath });
  }

  for (const file of files) {
    if (!isTestFile(file.path)) continue;
    for (const sourcePath of candidateSourcePaths(file.path)) {
      if (!fileSet.has(sourcePath)) continue;
      edges.push({
        sourceId: fileNodeId(sourcePath),
        targetId: fileNodeId(file.path),
        type: 'tests',
        confidence: 'exact',
        filePath: file.path,
      });
      break;
    }
  }

  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const sourceSymbolFor = (reference: ReferenceRecord): SymbolRecord | undefined => {
    if (reference.sourceSymbolId) return symbolsById.get(reference.sourceSymbolId);
    if (!reference.sourceSymbolName) return undefined;
    return symbolsByFileAndName.get(`${reference.filePath}\u0000${reference.sourceSymbolName.toLowerCase()}`)?.[0];
  };

  for (const reference of references) {
    if (reference.kind === 'call' && !config.graph.includeDirectCalls) continue;
    const sourceSymbol = sourceSymbolFor(reference);
    const sourceId = sourceSymbol?.id ?? fileNodeId(reference.filePath);
    const lowerTarget = reference.targetName.toLowerCase();
    let target: SymbolRecord | undefined;
    let confidence: GraphEdge['confidence'] = 'syntactic';

    const local = symbolsByFileAndName.get(`${reference.filePath}\u0000${lowerTarget}`);
    if (local?.length === 1) {
      target = local[0];
      confidence = 'resolved';
    } else {
      const imported = importsByLocal.get(`${reference.filePath}\u0000${lowerTarget}`);
      if (imported?.resolvedPath) {
        const importedName = imported.importedName && imported.importedName !== '*' && imported.importedName !== 'default'
          ? imported.importedName : reference.targetName;
        const importedSymbols = symbolsByFileAndName.get(`${imported.resolvedPath}\u0000${importedName.toLowerCase()}`);
        if (importedSymbols?.length === 1) {
          target = importedSymbols[0];
          confidence = 'resolved';
        }
      }
    }

    if (!target) {
      const global = symbolsByName.get(lowerTarget);
      if (global?.length === 1) {
        target = global[0];
        confidence = 'heuristic';
      }
    }
    if (!target) continue;

    edges.push({
      sourceId, targetId: target.id,
      type: reference.kind === 'call' ? 'calls' : reference.kind === 'reference' ? 'references' : reference.kind,
      confidence, filePath: reference.filePath,
    });
  }

  store.replaceEdges(edges);
}
