// Runs bot decisions off the main thread, so a deep search never freezes the UI.

import { chooseAction } from '../bot/bot.ts';
import { createRng } from '../engine/index.ts';
import type { ThinkRequest, ThinkReply } from './think.ts';

self.onmessage = (e: MessageEvent<ThinkRequest>) => {
  const { id, view, personality, memory, seed } = e.data;
  let reply: ThinkReply;
  try {
    reply = { id, decision: chooseAction(view, personality, memory, createRng(seed)) };
  } catch (err) {
    reply = { id, decision: null, error: String(err) };
  }
  self.postMessage(reply);
};
