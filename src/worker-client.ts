import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type {
  CodeIndexConfig, CodeIndexEvent, ContextRequest, ContextResult, IndexRunResult, IndexStats,
  RelatedNode, SearchOptions, SearchResult, SymbolRecord,
} from './types.js';

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type SerializedError = { name?: string; message?: string; stack?: string; code?: string };

function deserializeError(value: SerializedError | undefined, fallback: string): Error {
  const error = new Error(value?.message ?? fallback);
  error.name = value?.name ?? 'Error';
  if (value?.stack) error.stack = value.stack;
  if (value?.code) Object.assign(error, { code: value.code });
  return error;
}

function assertWorkerCompatible(config: CodeIndexConfig): void {
  if (config.syntaxProviders?.length) throw new Error('WorkerCodeIndex does not accept custom syntaxProviders because functions cannot be structured-cloned. Use CodeIndex directly or package the provider into the worker.');
  if (config.logger) throw new Error('WorkerCodeIndex does not accept a logger object. Subscribe to CodeIndex events instead.');
}

export class WorkerCodeIndex extends EventEmitter {
  readonly worker: Worker;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;
  #ready: Promise<void>;
  #readySettled = false;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #failure?: Error;

  constructor(config: CodeIndexConfig) {
    super();
    assertWorkerCompatible(config);
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.#ready.catch(() => undefined);
    this.worker = new Worker(new URL('./worker-host.js', import.meta.url), { workerData: config });
    this.worker.on('message', (message: any) => {
      if (message?.type === 'ready') {
        if (!this.#readySettled && !this.#failure) {
          this.#readySettled = true;
          this.#resolveReady();
        }
        return;
      }
      if (message?.type === 'startup-error') {
        this.failTerminal(deserializeError(message.error, 'Code index worker failed to start'));
        return;
      }
      if (message?.type === 'event') {
        this.emit('event', message.event as CodeIndexEvent);
        return;
      }
      if (message?.type !== 'response' || typeof message.id !== 'number') return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(deserializeError(message.error, 'Code index worker request failed'));
      } else pending.resolve(message.result);
    });
    this.worker.on('error', (error: Error) => this.failTerminal(error));
    this.worker.on('exit', (code) => {
      if (!this.#closed && !this.#failure) {
        const phase = this.#readySettled ? 'unexpectedly' : 'before becoming ready';
        this.failTerminal(new Error(`Code index worker exited ${phase} with code ${code}`));
      }
    });
  }

  onEvent(listener: (event: CodeIndexEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('WorkerCodeIndex is closed'));
    if (this.#failure) return Promise.reject(this.#failure);
    await this.#ready;
    if (this.#closed) return Promise.reject(new Error('WorkerCodeIndex is closed'));
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  start(): Promise<IndexRunResult> { return this.call('start'); }
  indexWorkspace(): Promise<IndexRunResult> { return this.call('indexWorkspace'); }
  reconcile(): Promise<IndexRunResult> { return this.call('reconcile'); }
  indexFile(filePath: string): Promise<'indexed' | 'unchanged' | 'fallback' | 'skipped'> { return this.call('indexFile', filePath); }
  removeFile(filePath: string): Promise<boolean> { return this.call('removeFile', filePath); }
  search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> { return this.call('search', query, options); }
  findSymbol(name: string, limit = 50): Promise<SymbolRecord[]> { return this.call('findSymbol', name, limit); }
  getRelated(idOrName: string): Promise<RelatedNode[]> { return this.call('getRelated', idOrName); }
  getContext(request: ContextRequest): Promise<ContextResult> { return this.call('getContext', request); }
  getStats(): Promise<IndexStats> { return this.call('getStats'); }
  reset(): Promise<IndexRunResult> { return this.call('reset'); }
  startWatching(): Promise<void> { return this.call('startWatching'); }
  stopWatching(): Promise<void> { return this.call('stopWatching'); }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      if (!this.#failure) await this.call<void>('close');
    } finally {
      this.#closed = true;
      await this.worker.terminate();
      this.failAll(new Error('WorkerCodeIndex closed'));
      this.removeAllListeners();
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  private failTerminal(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady(error);
    }
    this.failAll(error);
  }
}

export function createWorkerCodeIndex(config: CodeIndexConfig): WorkerCodeIndex {
  return new WorkerCodeIndex(config);
}
