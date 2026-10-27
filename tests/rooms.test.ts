import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIC_ARRANGEMENT } from '../engine/index.ts';
import type { Action, Color } from '../engine/index.ts';
import { Rooms, RoomError } from '../tools/rooms.ts';
import type { RoomMessage } from '../net/protocol.ts';

type State = Extract<RoomMessage, { type: 'state' }>;

function setupRoom() {
  const rooms = new Rooms();
  const host = rooms.create('Ann', 'white');
  const guest = rooms.join(host.code, 'Bo');
  const inbox: Record<Color, State[]> = { white: [], black: [] };
  rooms.subscribe(host.code, host.token, (m) => inbox.white.push(m as State));
  rooms.subscribe(host.code, guest.token, (m) => inbox.black.push(m as State));
  const last = (c: Color) => inbox[c][inbox[c].length - 1];
  const act = (token: string, action: Action) => rooms.act(host.code, token, action);
  return { rooms, host, guest, last, act, arrangement: [...CLASSIC_ARRANGEMENT] };
}

/** HTTP status a room call would answer with. */
function status(fn: () => void): number {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof RoomError);
    return e.status;
  }
  return 200;
}

test('rooms: create, join, and refuse a third player or a bad code', () => {
  const rooms = new Rooms();
  const host = rooms.create('Ann', 'black');
  assert.match(host.code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(host.color, 'black');
  const guest = rooms.join(host.code.toLowerCase(), 'Bo');
  assert.equal(guest.color, 'white');
  assert.equal(status(() => rooms.join(host.code, 'Cy')), 409);
  assert.equal(status(() => rooms.join('ZZZZZ', 'Cy')), 404);
});

test('rooms: nobody can act before the second player joins', () => {
  const rooms = new Rooms();
  const host = rooms.create('Ann', 'white');
  assert.equal(status(() => rooms.act(host.code, host.token, { type: 'setup', player: 'white', arrangement: [...CLASSIC_ARRANGEMENT] })), 409);
});

test('rooms: each player only ever sees their own hidden cards', () => {
  const { host, guest, last, act, arrangement } = setupRoom();
  // b1 is really a bishop, so the knight claim is a lie.
  act(host.token, { type: 'setup', player: 'white', arrangement: ['rook', 'bishop', 'knight', 'queen', 'bishop', 'knight', 'rook'] });
  act(guest.token, { type: 'setup', player: 'black', arrangement });
  act(host.token, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' });
  const w = last('white').view, b = last('black').view;
  assert.ok(w.pieces.filter((p) => p.owner === 'white' && !p.faceUp).every((p) => p.type));
  assert.ok(w.pieces.filter((p) => p.owner === 'black' && !p.faceUp).every((p) => p.type === null));
  assert.ok(b.pieces.filter((p) => p.owner === 'white' && !p.faceUp).every((p) => p.type === null));
  assert.equal(b.pending?.honest, undefined, 'the caller must not learn whether the claim is honest');
  assert.equal(w.pending?.honest, false);
  assert.ok(last('black').events.some((e) => e.type === 'claimMade'));
  // The history never carries the other side's arrangement.
  assert.ok(b.history.every((a) => a.type !== 'setup' || a.player === 'black' || !a.arrangement));
});

test('rooms: actions are checked against the seat and the rules', () => {
  const { host, guest, act, arrangement } = setupRoom();
  assert.equal(status(() => act(guest.token, { type: 'setup', player: 'white', arrangement })), 403);
  assert.equal(status(() => act('not-a-token', { type: 'setup', player: 'white', arrangement })), 403);
  act(host.token, { type: 'setup', player: 'white', arrangement });
  act(guest.token, { type: 'setup', player: 'black', arrangement });
  assert.equal(status(() => act(guest.token, { type: 'move', player: 'black', from: 'e7', to: 'e5' })), 409, "not black's turn");
  assert.equal(status(() => act(host.token, { type: 'move', player: 'white', from: 'e2', to: 'e5' })), 409, 'not a legal move');
  assert.equal(status(() => act(host.token, { type: 'move', player: 'white', from: 'e2', to: 'e4' })), 200);
});

test('rooms: presence, and a rematch swaps colours', () => {
  const { rooms, host, guest, last, act, arrangement } = setupRoom();
  assert.deepEqual(last('white').seated, { white: true, black: true });
  assert.deepEqual(last('white').online, { white: true, black: true });
  act(host.token, { type: 'setup', player: 'white', arrangement });
  act(guest.token, { type: 'setup', player: 'black', arrangement });
  assert.equal(status(() => rooms.rematch(host.code, host.token)), 409, 'game still going');
  act(guest.token, { type: 'resign', player: 'black' });
  assert.equal(last('white').view.result?.winner, 'white');
  rooms.rematch(host.code, host.token);
  assert.deepEqual(last('black').rematch, { white: true, black: false });
  rooms.rematch(host.code, guest.token);
  assert.equal(last('white').game, 2);
  assert.equal(last('white').you, 'black');
  assert.equal(last('black').you, 'white');
  assert.equal(last('white').view.phase, 'setup');
});

test('rooms: idle rooms are swept', () => {
  const rooms = new Rooms();
  rooms.create('Ann', 'white');
  rooms.sweep(Date.now() + 60_000);
  assert.equal(rooms.size, 1);
  rooms.sweep(Date.now() + 4 * 60 * 60 * 1000);
  assert.equal(rooms.size, 0);
});

test('rooms: caps on rooms per address, rooms overall, and streams per seat', () => {
  const perAddress = new Rooms({ perAddressPerHour: 2 });
  perAddress.create('Ann', 'white', '1.2.3.4');
  perAddress.create('Ann', 'white', '1.2.3.4');
  assert.equal(status(() => perAddress.create('Ann', 'white', '1.2.3.4')), 429);
  perAddress.create('Bo', 'white', '5.6.7.8');

  const full = new Rooms({ maxRooms: 1 });
  full.create('Ann', 'white', 'a');
  assert.equal(status(() => full.create('Bo', 'white', 'b')), 503);

  const streams = new Rooms({ listenersPerSeat: 1 });
  const host = streams.create('Ann', 'white');
  streams.subscribe(host.code, host.token, () => {});
  assert.equal(status(() => streams.check(host.code, host.token)), 429);
});
