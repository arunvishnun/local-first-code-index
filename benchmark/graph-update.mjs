import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCodeIndex } from '../dist/index.js';

const requestedSizes = process.argv.slice(2).map(Number).filter((value) => Number.isInteger(value) && value > 0);
const sizes = requestedSizes.length > 0 ? requestedSizes : [100, 2_000, 10_000];

async function writeCorpus(root, size) {
  const sourceRoot = path.join(root, 'src');
  await mkdir(sourceRoot, { recursive: true });
  const batchSize = 200;
  for (let start = 0; start < size; start += batchSize) {
    const writes = [];
    for (let index = start; index < Math.min(size, start + batchSize); index += 1) {
      const priorImport = index === 0 ? '' : `import { symbol${index - 1} } from './file-${index - 1}.js';\n`;
      const priorCall = index === 0 ? 'return value;' : `return symbol${index - 1}(value);`;
      writes.push(writeFile(
        path.join(sourceRoot, `file-${index}.ts`),
        `${priorImport}export function symbol${index}(value: number) { ${priorCall} }\n`,
      ));
    }
    await Promise.all(writes);
  }
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Watcher benchmark timed out after ${timeoutMs}ms`);
}

async function measure(size) {
  const root = await mkdtemp(path.join(os.tmpdir(), `local-code-index-benchmark-${size}-`));
  let index;
  try {
    await writeCorpus(root, size);
    index = createCodeIndex({
      workspaceRoot: root,
      storagePath: path.join(root, '.local-code-index', 'index.sqlite'),
      watch: { enabled: false, debounceMs: 50, reconcileIntervalMs: 0 },
      fallbackSearch: { enabled: false },
      resources: { maxConcurrency: 2, yieldEveryFiles: 25 },
    });

    const initialStart = performance.now();
    const initial = await index.start();
    const initialMs = performance.now() - initialStart;

    const target = `src/file-${Math.floor(size / 2)}.ts`;
    const unchangedStart = performance.now();
    await index.indexFile(target);
    const unchangedUpdateMs = performance.now() - unchangedStart;

    const targetNumber = Math.floor(size / 2);
    await writeFile(
      path.join(root, target),
      `export function symbol${targetNumber}(value: number) { return value + 1; }\n`,
    );
    const changedStart = performance.now();
    await index.indexFile(target);
    const changedUpdateMs = performance.now() - changedStart;

    index.startWatching();
    const burstSize = Math.min(10, size);
    const expectedNames = [];
    const watcherStart = performance.now();
    for (let fileNumber = 0; fileNumber < burstSize; fileNumber += 1) {
      const name = `watchSymbol${fileNumber}`;
      expectedNames.push(name);
      await writeFile(path.join(root, 'src', `file-${fileNumber}.ts`), `export function ${name}() { return ${fileNumber}; }\n`);
    }
    const watcherBurstMs = await waitFor(() => expectedNames.every((name) => index.findSymbol(name).length === 1));
    index.stopWatching();

    const memory = process.memoryUsage();
    return {
      size,
      initialMs,
      unchangedUpdateMs,
      changedUpdateMs,
      watcherBurstMs,
      watcherBurstFiles: burstSize,
      initial,
      stats: index.getStats(),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
      },
    };
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const size of sizes) {
  const result = await measure(size);
  results.push(result);
  console.error(`completed graph benchmark for ${size} files`);
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
