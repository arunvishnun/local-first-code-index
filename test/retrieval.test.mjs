import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodeIndex } from '../dist/index.js';

async function writeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-retrieval-'));
  await mkdir(path.join(root, 'src', 'billing'), { recursive: true });
  await mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await mkdir(path.join(root, 'src', 'auth'), { recursive: true });
  await mkdir(path.join(root, 'src', 'config'), { recursive: true });
  await mkdir(path.join(root, 'app', 'api', 'checkout'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(path.join(root, 'src', 'billing', 'retry.ts'), `
export function retryPayment(orderId: string): string {
  return 'retried:' + orderId;
}

// Payment retry logic for checkout failures.
${'// pad\n'.repeat(40)}
`.trimStart());
  await writeFile(path.join(root, 'src', 'billing', 'checkout.ts'), `
import { retryPayment } from './retry';

export function checkoutService(orderId: string): string {
  return retryPayment(orderId);
}
`.trimStart());
  await writeFile(path.join(root, 'src', 'billing', 'retry.test.ts'), `
import { retryPayment } from './retry';

export function testRetryPayment(): string {
  return retryPayment('order-1');
}
`.trimStart());
  await writeFile(path.join(root, 'app', 'api', 'checkout', 'route.ts'), `
import { checkoutService } from '../../../src/billing/checkout';

export function POST(orderId: string): string {
  return checkoutService(orderId);
}
`.trimStart());
  await writeFile(path.join(root, 'src', 'components', 'CheckoutForm.tsx'), `
export function CheckoutForm() {
  return <form>checkout</form>;
}
`.trimStart());
  await writeFile(path.join(root, 'src', 'components', 'CheckoutButton.tsx'), `
import { CheckoutForm } from './CheckoutForm';

export function CheckoutButton() {
  return <CheckoutForm />;
}
`.trimStart());
  await writeFile(path.join(root, 'src', 'auth', 'session.ts'), `
export function useSession(): string {
  return 'local-user';
}
`.trimStart());
  await writeFile(path.join(root, 'src', 'config', 'payments.ts'), `
export const PAYMENT_RETRY_LIMIT = 3;
`.trimStart());
  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await mkdir(path.join(root, 'src', 'b'), { recursive: true });
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a', 'same.ts'), `export function retryNow() { return 'a'; }\n`);
  await writeFile(path.join(root, 'src', 'b', 'same.ts'), `export function retryNow() { return 'b'; }\n`);
  await writeFile(path.join(root, 'notes', 'binary.bin'), Buffer.from([0, 1, 2, 3, 4]));
  await writeFile(path.join(root, 'src', 'huge.txt'), `${'x'.repeat(2_000)}\n`);
  await writeFile(path.join(root, 'src', 'broken.txt'), 'this file is intentionally malformed for the test provider\n');
  await writeFile(path.join(root, 'src', 'ok.txt'), 'plain text companion file\n');
  await writeFile(path.join(root, 'node_modules', 'ignored', 'bad.ts'), 'export const SHOULD_NOT_INDEX = true;\n');
  return root;
}

test('context pack, navigation, ranking, budgets, and incremental metadata', async () => {
  const root = await writeRepo();
  let index;
  try {
    index = createCodeIndex({
      workspaceRoot: root,
      storagePath: path.join(root, '.index', 'index.sqlite'),
      watch: { enabled: false },
      fallbackSearch: { ripgrepPath: false },
      discovery: { maxFileBytes: 800 },
      syntaxProviders: [{
        name: 'boom',
        supports: ({ relativePath }) => relativePath.endsWith('broken.txt'),
        parse() { throw new Error('malformed fixture'); },
      }],
    });
    const run = await index.start();
    assert.equal(index.getIndexState().status, 'READY');
    assert.ok(run.discovered >= 8);
    assert.ok(run.dbBytes > 0);
    assert.ok(run.parseMs >= 0);
    assert.ok(run.writeMs >= 0);
    assert.equal(index.findSymbol('SHOULD_NOT_INDEX').length, 0);
    assert.equal(index.store.getFile('src/huge.txt'), undefined);
    assert.equal(index.store.getFile('notes/binary.bin'), undefined);
    assert.equal(index.store.getFile('src/broken.txt')?.parseStatus, 'fallback');
    assert.ok(index.store.getFile('src/ok.txt'));
    assert.ok(index.findSymbol('retryPayment').length > 0);

    const definition = await index.retrieveContext({ query: 'where is retryPayment defined', intent: 'definition' });
    assert.equal(definition.confidence, 'high');
    assert.equal(definition.intent, 'definition');
    assert.ok(definition.primary.some((snippet) => snippet.filePath === 'src/billing/retry.ts' && snippet.content.includes('retryPayment')));
    assert.equal(definition.related.length, 0);
    assert.ok(definition.metrics.bytesReturned < 20_000);
    assert.ok(definition.metrics.fullFileBytesAvoided > 0);
    assert.ok(definition.metrics.sourceLinesReturned < 30);

    const usages = await index.retrieveContext({ query: 'retryPayment', intent: 'usages', budget: { maxFiles: 4, maxSnippets: 4, maxLines: 80, maxBytes: 8_000, maxEstimatedTokens: 2_000, maxGraphDepth: 1 } });
    assert.ok(usages.related.some((snippet) => snippet.filePath === 'src/billing/checkout.ts'));
    assert.ok(usages.metrics.sourceLinesReturned <= 80);

    const references = index.findReferences('retryPayment');
    assert.ok(references.some((hit) => hit.filePath === 'src/billing/checkout.ts' && hit.kind === 'call'));
    const defined = index.getDefinition('retryPayment');
    assert.equal(defined?.filePath, 'src/billing/retry.ts');
    const outline = index.getFileOutline('src/billing/checkout.ts');
    assert.ok(outline.symbols.some((symbol) => symbol.name === 'checkoutService'));
    const snippet = await index.getSnippet('src/billing/retry.ts', defined.startLine, defined.endLine);
    assert.ok(snippet.content.includes('retryPayment'));
    assert.ok(snippet.bytesRead < 20_000);

    const tests = await index.retrieveContext({ query: 'retryPayment', intent: 'tests' });
    assert.ok(tests.related.some((snippet) => snippet.filePath === 'src/billing/retry.test.ts'));
    assert.ok(tests.relationships.some((item) => item.type === 'tests'));

    const button = index.findSymbol('CheckoutButton', { role: 'component' });
    assert.equal(button.length, 1);
    assert.equal(button[0].role, 'component');
    const hook = index.findSymbol('useSession', { role: 'hook' });
    assert.equal(hook[0].role, 'hook');
    const rendered = await index.retrieveContext({ query: 'CheckoutForm', intent: 'usages' });
    assert.ok(rendered.related.some((snippet) => snippet.filePath === 'src/components/CheckoutButton.tsx'));

    const ranked = await index.search('retryNow', { currentFile: 'src/b/same.ts', limit: 4 });
    assert.equal(ranked[0]?.filePath, 'src/b/same.ts');
    assert.ok(ranked[0]?.reasons.some((reason) => reason.source === 'proximity'));

    await index.search('retryPayment');
    const cached = await index.search('retryPayment');
    assert.equal(index.getLastRetrieval()?.cacheHit, true);
    assert.ok(cached.some((result) => result.filePath === 'src/billing/retry.ts'));
    assert.ok(index.getStats().cacheHits >= 1);

    const limited = await index.retrieveContext({
      query: 'retryPayment',
      intent: 'definition',
      budget: { maxFiles: 1, maxSnippets: 1, maxLines: 8, maxBytes: 400, maxEstimatedTokens: 100, maxGraphDepth: 0 },
    });
    assert.equal(limited.primary.length, 1);
    assert.ok(limited.metrics.sourceLinesReturned <= 8);
    assert.ok(limited.metrics.estimatedTokens <= 100);

    assert.equal(index.getIndexState().status, 'READY');
    assert.ok(index.getFileOutline('src/billing/retry.ts').symbols.some((symbol) => symbol.name === 'retryPayment'));
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation leaves a partial index marked stale instead of failing the process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-cancel-'));
  let index;
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      await writeFile(path.join(root, 'src', `file-${i}.ts`), `export function symbol${i}() { return ${i}; }\n`);
    }
    index = createCodeIndex({
      workspaceRoot: root,
      storagePath: ':memory:',
      watch: { enabled: false },
      resources: { yieldEveryFiles: 1, maxConcurrency: 1 },
    });
    const controller = new AbortController();
    index.onEvent((event) => {
      if (event.type === 'index-progress') controller.abort();
    });
    await assert.rejects(() => index.indexWorkspace({ signal: controller.signal }), (error) => error.name === 'AbortError');
    assert.equal(index.getIndexState().status, 'STALE');
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(() => index.indexWorkspace({ signal: alreadyAborted.signal }), (error) => error.name === 'AbortError');
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('one failing parser does not fail indexing of the other files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-code-index-isolate-'));
  let index;
  try {
    await writeFile(path.join(root, 'broken.txt'), 'malformed\n');
    await writeFile(path.join(root, 'kept.ts'), 'export function keptSymbol() { return 1; }\n');
    index = createCodeIndex({
      workspaceRoot: root,
      storagePath: ':memory:',
      watch: { enabled: false },
      syntaxProviders: [{
        name: 'boom',
        supports: ({ relativePath }) => relativePath.endsWith('broken.txt'),
        parse() { throw new Error('malformed'); },
      }],
    });
    const run = await index.start();
    assert.ok(run.discovered >= 2);
    assert.equal(index.findSymbol('keptSymbol').length, 1);
    assert.equal(index.getIndexState().status, 'READY');
  } finally {
    if (index) await index.close();
    await rm(root, { recursive: true, force: true });
  }
});
