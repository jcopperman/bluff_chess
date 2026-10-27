// Online play: talks to the room server (tools/rooms.ts, hosted by `npm start`).
// The server holds the real game; this side only ever receives our own view.

import type { Action, Color } from '../engine/index.ts';
import type { ColorChoice, RoomMessage, Seat } from '../net/protocol.ts';

export type { RoomMessage, Seat };

/** Where the rooms live: '' for the server that served this page, else the hosted server's URL. Set by serverAvailable(). */
let base = '';

function rooms(path = ''): string {
  return `${base}api/rooms${path}`;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rooms(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Can\'t reach the game server.');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || (res.status === 404 ? 'Online play needs the Bluff Chess server (npm start).' : `Server error ${res.status}`));
  return data;
}

async function answers(server: string): Promise<boolean> {
  try {
    const res = await fetch(`${server}api/rooms`, { cache: 'no-store' });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/**
 * Whether a room server is answering. The server that served this page comes first
 * (`npm start`, or the hosted copy); static hosts like itch.io have none, so then
 * we try the hosted server named in index.html's server meta tag.
 */
export async function serverAvailable(): Promise<boolean> {
  if (await answers('')) {
    base = '';
    return true;
  }
  const hosted = document.querySelector<HTMLMetaElement>('meta[name=server]')?.content.trim().replace(/\/*$/, '/');
  if (hosted && hosted !== '/' && await answers(hosted)) {
    base = hosted;
    return true;
  }
  return false;
}

export async function createRoom(name: string, color: ColorChoice): Promise<Seat> {
  const r = await post<{ code: string; token: string; color: Color }>('', { name, color });
  return { code: r.code, token: r.token, color: r.color };
}

export async function joinRoom(code: string, name: string): Promise<Seat> {
  const clean = code.trim().toUpperCase();
  const r = await post<{ token: string; color: Color }>(`/${encodeURIComponent(clean)}/join`, { name });
  return { code: clean, token: r.token, color: r.color };
}

export function sendAction(seat: Seat, action: Action): Promise<unknown> {
  return post(`/${seat.code}/action`, { token: seat.token, action });
}

export function requestRematch(seat: Seat): Promise<unknown> {
  return post(`/${seat.code}/rematch`, { token: seat.token });
}

/** Listen to the room. EventSource reconnects by itself; `onDown` reports lost connections. */
export function connect(seat: Seat, onMessage: (m: RoomMessage) => void, onDown: (down: boolean) => void): () => void {
  const es = new EventSource(rooms(`/${seat.code}/events?token=${encodeURIComponent(seat.token)}`));
  es.onmessage = (e: MessageEvent<string>) => {
    onDown(false);
    onMessage(JSON.parse(e.data) as RoomMessage);
  };
  es.onerror = () => onDown(true);
  return () => es.close();
}

const KEY = 'bluffchess.seat';

/** Remember our seat for this tab, so a reload rejoins the game. */
export function rememberSeat(seat: Seat | null): void {
  try {
    if (seat) sessionStorage.setItem(KEY, JSON.stringify(seat));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: a reload just won't rejoin.
  }
}

export function savedSeat(): Seat | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Seat) : null;
  } catch {
    return null;
  }
}
