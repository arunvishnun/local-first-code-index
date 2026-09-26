import { parentPort, workerData } from 'node:worker_threads';
import { CodeIndex } from './code-index.js';
import type { CodeIndexConfig } from './types.js';

if (!parentPort) throw new Error('worker-host must run inside a worker thread');
const port = parentPort;

function serializeError(error: unknown): { name: string; message: string; stack?: string; code?: string } {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as Error & { code?: unknown }).code;
  return {
    name: err.name,
    message: err.message,
    ...(err.stack ? { stack: err.stack } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

try {
  const index = new CodeIndex(workerData as CodeIndexConfig);
  index.onEvent((event) => port.postMessage({ type: 'event', event }));

  port.on('message', async (message: { id: number; method: string; args: unknown[] }) => {
    try {
      let result: unknown;
      switch (message.method) {
        case 'start': result = await index.start(); break;
        case 'indexWorkspace': result = await index.indexWorkspace(); break;
        case 'reconcile': result = await index.reconcile(); break;
        case 'indexFile': result = await index.indexFile(message.args[0] as string); break;
        case 'removeFile': result = index.removeFile(message.args[0] as string); break;
        case 'search': result = await index.search(message.args[0] as string, (message.args[1] ?? {}) as any); break;
        case 'findSymbol': result = index.findSymbol(message.args[0] as string, message.args[1] as number | undefined); break;
        case 'getRelated': result = index.getRelated(message.args[0] as string); break;
        case 'getContext': result = await index.getContext(message.args[0] as any); break;
        case 'getStats': result = index.getStats(); break;
        case 'reset': result = await index.reset(); break;
        case 'startWatching': index.startWatching(); result = undefined; break;
        case 'stopWatching': index.stopWatching(); result = undefined; break;
        case 'close': await index.close(); result = undefined; break;
        default: throw new Error(`Unknown worker method: ${message.method}`);
      }
      port.postMessage({ type: 'response', id: message.id, result });
    } catch (error) {
      port.postMessage({ type: 'response', id: message.id, error: serializeError(error) });
    }
  });
  port.postMessage({ type: 'ready' });
} catch (error) {
  port.postMessage({
    type: 'startup-error',
    error: serializeError(error),
  });
  setImmediate(() => port.close());
}
