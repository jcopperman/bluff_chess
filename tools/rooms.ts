// Online rooms: the server holds the true game state and runs the same engine
// as the browser. Each player only ever receives their own view, so no client
// can see the other side's hidden cards. Transport-agnostic: serve.ts wires it
// to HTTP and server-sent events.

import { randomInt, randomUUID } from 'node:crypto';
import * as E from '../engine/index.ts';
import type { Action, Color, GameEvent, GameState } from '../engine/index.ts';
import type { ColorChoice, RoomMessage } from '../net/protocol.ts';

export type { ColorChoice, RoomMessage };

type Send = (msg: RoomMessage) => void;

interface Seat {
  token: string;
  name: string;
  color: Color;
  listeners: Set<Send>;
  rematch: boolean;
}

interface Room {
  code: string;
  state: GameState;
  seats: Seat[];
  game: number;
  touched: number;
}

export class RoomError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** No I, O, 0 or 1, so codes read aloud cleanly. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE_MS = 3 * 60 * 60 * 1000;

export function cleanName(name: unknown, fallback: string): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) : '';
  return s || fallback;
}

export class Rooms {
  private rooms = new Map<string, Room>();

  /** Open a room and take a seat in it. */
  create(name: unknown, choice: ColorChoice = 'random'): { code: string; token: string; color: Color } {
    let code: string;
    do {
      code = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const color: Color = choice === 'white' || choice === 'black' ? choice : randomInt(2) ? 'white' : 'black';
    const seat: Seat = { token: randomUUID(), name: cleanName(name, 'Host'), color, listeners: new Set(), rematch: false };
    this.rooms.set(code, { code, state: E.createGame(), seats: [seat], game: 1, touched: Date.now() });
    return { code, token: seat.token, color };
  }

  /** Take the free seat in a room. */
  join(code: string, name: unknown): { token: string; color: Color } {
    const room = this.room(code);
    if (room.seats.length >= 2) throw new RoomError('That room is full.', 409);
    const color = E.opponent(room.seats[0].color);
    const seat: Seat = { token: randomUUID(), name: cleanName(name, 'Guest'), color, listeners: new Set(), rematch: false };
    room.seats.push(seat);
    this.broadcast(room, []);
    return { token: seat.token, color };
  }

  /** Throw unless `token` holds a seat in room `code`. */
  check(code: string, token: string): void {
    this.seat(this.room(code), token);
  }

  /** Listen for a seat's updates; the current state is sent straight away. Returns an unsubscribe function. */
  subscribe(code: string, token: string, send: Send): () => void {
    const room = this.room(code);
    const seat = this.seat(room, token);
    seat.listeners.add(send);
    this.broadcast(room, []);
    return () => {
      seat.listeners.delete(send);
      if (this.rooms.has(code)) this.broadcast(room, []);
    };
  }

  act(code: string, token: string, action: Action): void {
    const room = this.room(code);
    const seat = this.seat(room, token);
    if (room.seats.length < 2) throw new RoomError('Waiting for an opponent to join.', 409);
    if (!action || typeof action !== 'object' || action.player !== seat.color) throw new RoomError('Not your seat.', 403);
    const legal = action.type === 'setup' || E.getLegalActions(room.state, seat.color).some((a) => sameAction(a, action));
    if (!legal) throw new RoomError('That action is not legal right now.', 409);
    let result: ReturnType<typeof E.applyAction>;
    try {
      result = E.applyAction(room.state, action);
    } catch (e) {
      throw new RoomError((e as Error).message, 409);
    }
    room.state = result.state;
    this.broadcast(room, result.events);
  }

  /** Ask for a rematch; when both players have asked, a new game starts with colours swapped. */
  rematch(code: string, token: string): void {
    const room = this.room(code);
    const seat = this.seat(room, token);
    if (room.state.phase !== 'over') throw new RoomError('The game is still going.', 409);
    seat.rematch = true;
    if (room.seats.length === 2 && room.seats.every((s) => s.rematch)) {
      for (const s of room.seats) {
        s.color = E.opponent(s.color);
        s.rematch = false;
      }
      room.state = E.createGame();
      room.game++;
    }
    this.broadcast(room, []);
  }

  /** Drop rooms nobody has touched for a while. */
  sweep(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      if (now - room.touched > IDLE_MS) this.rooms.delete(code);
    }
  }

  get size(): number {
    return this.rooms.size;
  }

  private room(code: string): Room {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) throw new RoomError('No room with that code.', 404);
    room.touched = Date.now();
    return room;
  }

  private seat(room: Room, token: string): Seat {
    const seat = room.seats.find((s) => s.token === token);
    if (!seat) throw new RoomError('Not a player in this room.', 403);
    return seat;
  }

  private broadcast(room: Room, events: GameEvent[]): void {
    const names = { white: 'White', black: 'Black' } as Record<Color, string>;
    const online = { white: false, black: false } as Record<Color, boolean>;
    const rematch = { white: false, black: false } as Record<Color, boolean>;
    const seated = { white: false, black: false } as Record<Color, boolean>;
    for (const s of room.seats) {
      seated[s.color] = true;
      names[s.color] = s.name;
      online[s.color] = s.listeners.size > 0;
      rematch[s.color] = s.rematch;
    }
    for (const s of room.seats) {
      const msg: RoomMessage = {
        type: 'state', view: E.getPlayerView(room.state, s.color), events, you: s.color, names, seated, online, game: room.game, rematch,
      };
      for (const send of s.listeners) send(msg);
    }
  }
}

/** Same action, ignoring field order and absent optional fields. */
function sameAction(a: Action, b: Action): boolean {
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => (x[k] ?? null) === (y[k] ?? null));
}
