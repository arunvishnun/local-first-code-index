import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createCodeIndex } from '../dist/index.js';

const questions = [
  { id: 'definition', query: 'where is retryPayment defined', intent: 'definition', expectFile: 'src/billing/retry.ts' },
  { id: 'usages', query: 'where is retryPayment used', intent: 'usages', expectFile: 'src/billing/checkout.ts' },
  { id: 'callers', query: 'what calls retryPayment', intent: 'callers', expectFile: 'src/billing/checkout.ts' },
  { id: 'route', query: 'checkout route handler', intent: 'route', expectFile: 'app/api/checkout/route.ts' },
  { id: 'retry-logic', query: 'payment retry logic', intent: 'general', expectFile: 'src/billing/retry.ts' },
  { id: 'component', query: 'which component renders CheckoutForm', intent: 'usages', expectFile: 'src/components/CheckoutButton.tsx' },
  { id: 'tests', query: 'which tests cover retryPayment', intent: 'tests', expectFile: 'src/billing/retry.test.ts' },
  { id: 'config', query: 'PAYMENT_RETRY_LIMIT', intent: 'definition', expectFile: 'src/config/payments.ts' },
];

function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

async function writeHandcrafted(root) {
  await mkdir(path.join(root, 'src', 'billing'), { recursive: true });
  await mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await mkdir(path.join(root, 'src', 'auth'), { recursive: true });
  await mkdir(path.join(root, 'src', 'config'), { recursive: true });
  await mkdir(path.join(root, 'app', 'api', 'checkout'), { recursive: true });
  const files = new Map();
  const put = async (relativePath, content) => {
    const absolute = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    files.set(relativePath, content);
  };
  await put('src/billing/retry.ts', `export function retryPayment(orderId: string): string {\n  return 'retried:' + orderId;\n}\n\n// Payment retry logic for checkout failures.\n${'// retained context beyond the function\n'.repeat(40)}`);
  await put('src/billing/checkout.ts', `import { retryPayment } from './retry';\n\nexport function checkoutService(orderId: string): string {\n  return retryPayment(orderId);\n}\n`);
  await put('src/billing/retry.test.ts', `import { retryPayment } from './retry';\n\nexport function testRetryPayment(): string {\n  return retryPayment('order-1');\n}\n`);
  await put('app/api/checkout/route.ts', `import { checkoutService } from '../../../src/billing/checkout';\n\nexport function POST(orderId: string): string {\n  return checkoutService(orderId);\n}\n`);
  await put('src/components/CheckoutForm.tsx', `export function CheckoutForm() {\n  return <form>checkout</form>;\n}\n`);
  await put('src/components/CheckoutButton.tsx', `import { CheckoutForm } from './CheckoutForm';\n\nexport function CheckoutButton() {\n  return <CheckoutForm />;\n}\n`);
  await put('src/auth/session.ts', `export function useSession(): string {\n  return 'local-user';\n}\n`);
  await put('src/config/payments.ts', `export const PAYMENT_RETRY_LIMIT = 3;\n`);
  await put('README.md', '# Demo\n\nAuthentication stays local. Checkout error handling lives beside retryPayment.\n');
  return files;
}

async function writeGenerated(root, count, files) {
  await mkdir(path.join(root, 'generated'), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const relativePath = `generated/file-${index}.ts`;
    const content = `export function generatedSymbol${index}(value: number): number {\n  return value + ${index};\n}\n`;
    await writeFile(path.join(root, 'generated', `file-${index}.ts`), content);
    files.set(relativePath, content);
  }
}

function baselineLookup(files, question) {
  const started = performance.now();
  const tokens = question.query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const interesting = tokens.filter((token) => !['where', 'what', 'which', 'with', 'from', 'that', 'this', 'does', 'into', 'cover', 'calls', 'used', 'defined'].includes(token));
  const needles = interesting.length > 0 ? interesting : tokens;
  const matches = [];
  for (const [filePath, content] of files) {
    const haystack = `${filePath}\n${content}`.toLowerCase();
    if (needles.some((needle) => haystack.includes(needle))) matches.push({ filePath, content });
  }
  const bytes = matches.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const lines = matches.reduce((sum, file) => sum + file.content.split('\n').length, 0);
  return {
    mode: 'baseline-full-file',
    latencyMs: performance.now() - started,
    toolCalls: 1 + matches.length,
    fileReads: matches.length,
    fullFileReads: matches.length,
    filesReturned: matches.length,
    sourceLines: lines,
    bytes,
    estimatedTokens: estimateTokens(bytes),
    modelCalls: matches.length > 0 ? 2 : 1,
    taskSuccess: matches.some((file) => file.filePath === question.expectFile),
  };
}

function indexedSuccess(pack, expectFile) {
  return [...pack.primary, ...pack.related].some((snippet) => snippet.filePath === expectFile);
}

async function measureRepo(label, extraFiles) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-bench-'));
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-bench-db-'));
  let index;
  try {
    const files = await writeHandcrafted(root);
    if (extraFiles > 0) await writeGenerated(root, extraFiles, files);
    const selectedQuestions = extraFiles > 0 ? questions.slice(0, 2) : questions;
    const baseline = selectedQuestions.map((question) => ({ id: question.id, ...baselineLookup(files, question) }));

    index = createCodeIndex({
      workspaceRoot: root,
      storagePath: path.join(storageRoot, 'index.sqlite'),
      watch: { enabled: false },
      fallbackSearch: { ripgrepPath: false },
      resources: { maxConcurrency: 2 },
    });
    const indexRun = await index.start();
    const indexed = [];
    for (const question of selectedQuestions) {
      const pack = await index.retrieveContext({ query: question.query, intent: question.intent });
      indexed.push({
        id: question.id,
        mode: 'indexed-context-pack',
        latencyMs: pack.metrics.durationMs,
        toolCalls: 1,
        fileReads: pack.metrics.filesRepresented,
        fullFileReads: 0,
        filesReturned: pack.metrics.filesRepresented,
        snippetsReturned: pack.metrics.snippetsReturned,
        sourceLines: pack.metrics.sourceLinesReturned,
        bytes: pack.metrics.bytesReturned,
        estimatedTokens: pack.metrics.estimatedTokens,
        fullFileBytesAvoided: pack.metrics.fullFileBytesAvoided,
        modelCalls: 1,
        confidence: pack.confidence,
        taskSuccess: indexedSuccess(pack, question.expectFile),
        indexQueries: pack.metrics.indexQueries,
        graphExpansions: pack.metrics.graphExpansions,
        cacheHit: pack.metrics.cacheHit,
      });
    }
    const repeated = await index.retrieveContext({ query: questions[0].query, intent: questions[0].intent });
    const editedPath = path.join(root, 'src', 'billing', 'retry.ts');
    const current = await readFile(editedPath, 'utf8');
    await writeFile(editedPath, current.replace('retried:', 'retried-again:'));
    const incrementalStarted = performance.now();
    const incrementalOutcome = await index.indexFile('src/billing/retry.ts');
    const incremental = index.getIndexState().lastIncremental;
    return {
      label,
      filesOnDisk: files.size,
      indexing: {
        discovered: indexRun.discovered,
        indexed: indexRun.indexed,
        unchanged: indexRun.unchanged,
        skipped: indexRun.skipped,
        ignored: indexRun.ignored,
        durationMs: indexRun.durationMs,
        parseMs: indexRun.parseMs,
        writeMs: indexRun.writeMs,
        dbBytes: indexRun.dbBytes,
        peakRssBytes: indexRun.peakRssBytes,
        indexRevision: indexRun.indexRevision,
      },
      questions: selectedQuestions.map((question) => ({
        id: question.id,
        query: question.query,
        intent: question.intent,
        expectFile: question.expectFile,
        baseline: baseline.find((item) => item.id === question.id),
        indexed: indexed.find((item) => item.id === question.id),
      })),
      incremental: {
        outcome: incrementalOutcome,
        elapsedMs: incremental?.elapsedMs ?? (performance.now() - incrementalStarted),
        changedFiles: incremental?.changedFiles ?? 1,
        filesReparsed: incremental?.filesReparsed ?? 0,
        relationshipsRecalculated: incremental?.relationshipsRecalculated ?? 0,
        cacheInvalidations: incremental?.cacheInvalidations ?? 0,
      },
      repeatedLookup: {
        cacheHit: repeated.metrics.cacheHit,
        latencyMs: repeated.metrics.durationMs,
        estimatedTokens: repeated.metrics.estimatedTokens,
      },
    };
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  note: 'Baseline simulates grep-then-read-full-file exploration. Indexed numbers are retrieveContext context packs. Model-call counts are a stand-in for one pack versus one search round trip plus one read round trip per matching file; they are not live LLM calls.',
  repositories: [
    await measureRepo('small-next-like', 0),
    await measureRepo('next-like-plus-80', 80),
    await measureRepo('next-like-plus-250', 250),
  ],
};

const outputDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'retrieval.json');
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

function average(items, read) {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + read(item), 0) / items.length;
}

console.log(`Wrote ${outputPath}`);
for (const repo of report.repositories) {
  const indexed = repo.questions.map((question) => question.indexed);
  const baseline = repo.questions.map((question) => question.baseline);
  const successes = indexed.filter((item) => item.taskSuccess).length;
  console.log(`\n${repo.label} (${repo.filesOnDisk} files)`);
  console.log(`  index ${repo.indexing.durationMs.toFixed(1)} ms, parse ${repo.indexing.parseMs.toFixed(1)} ms, write ${repo.indexing.writeMs.toFixed(1)} ms, db ${repo.indexing.dbBytes} bytes, rss ${repo.indexing.peakRssBytes} bytes`);
  console.log(`  questions ${successes}/${indexed.length} indexed hits`);
  console.log(`  mean lookup ${average(indexed, (item) => item.latencyMs).toFixed(2)} ms indexed vs ${average(baseline, (item) => item.latencyMs).toFixed(2)} ms baseline`);
  console.log(`  mean tokens ${average(indexed, (item) => item.estimatedTokens).toFixed(1)} indexed vs ${average(baseline, (item) => item.estimatedTokens).toFixed(1)} baseline`);
  console.log(`  mean full-file reads ${average(indexed, (item) => item.fullFileReads).toFixed(1)} indexed vs ${average(baseline, (item) => item.fullFileReads).toFixed(1)} baseline`);
  if (repo.incremental) console.log(`  incremental edit ${repo.incremental.elapsedMs.toFixed(1)} ms, reparsed ${repo.incremental.filesReparsed}, relationships ${repo.incremental.relationshipsRecalculated}`);
}
