// Online play: talks to the room server (tools/rooms.ts, hosted by `npm start`).
// The server holds the real game; this side only ever receives our own view.

import type { Action, Color } from '../engine/index.ts';
import type { ColorChoice, RoomMessage, Seat } from '../net/protocol.ts';

export type { RoomMessage, Seat };

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`api/rooms${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Can\'t reach the game server.');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || (res.status === 404 ? 'Online play needs the Bluff Chess server (npm start).' : `Server error ${res.status}`));
  return data;
}

/** Whether a room server is answering. Static hosts (itch.io and the like) have none. */
export async function serverAvailable(): Promise<boolean> {
  try {
    const res = await fetch('api/rooms', { cache: 'no-store' });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
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
  const es = new EventSource(`api/rooms/${seat.code}/events?token=${encodeURIComponent(seat.token)}`);
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
