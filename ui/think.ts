// Asks the bot for a decision in a Web Worker, falling back to the main thread
// where workers aren't available.

import { chooseAction } from '../bot/bot.ts';
import type { Decision, Personality, TableImage } from '../bot/bot.ts';
import { createRng } from '../engine/index.ts';
import type { PlayerView } from '../engine/index.ts';

export interface ThinkRequest {
  id: number;
  view: PlayerView;
  personality: Personality;
  memory: Partial<TableImage>;
  seed: number;
}

export interface ThinkReply {
  id: number;
  decision: Decision | null;
  error?: string;
}

let worker: Worker | null | undefined;
let nextId = 1;
/** Pending requests; resolving with undefined means "retry on the main thread". */
const waiting = new Map<number, (d: Decision | null | undefined) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./botWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ThinkReply>) => {
      if (e.data.error) console.error('Bot worker:', e.data.error);
      waiting.get(e.data.id)?.(e.data.decision);
      waiting.delete(e.data.id);
    };
    worker.onerror = (e) => {
      // A worker that fails to load (old browser, file://) hands every request back to the main thread.
      console.warn('Bot worker unavailable, thinking on the main thread.', e.message);
      worker?.terminate();
      worker = null;
      const stranded = [...waiting.values()];
      waiting.clear();
      stranded.forEach((retry) => retry(undefined));
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function think(view: PlayerView, personality: Personality, memory: Partial<TableImage>, seed: number): Promise<Decision | null> {
  const inline = () => chooseAction(view, personality, memory, createRng(seed));
  const w = getWorker();
  if (!w) return Promise.resolve(inline());
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, (d) => resolve(d === undefined ? inline() : d));
    w.postMessage({ id, view, personality, memory, seed } satisfies ThinkRequest);
  });
}
