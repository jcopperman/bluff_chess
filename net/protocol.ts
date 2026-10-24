// Messages between the online room server (tools/rooms.ts) and the browser (ui/online.ts).

import type { Color, GameEvent, PlayerView } from '../engine/index.ts';

export type ColorChoice = Color | 'random';

/** What a player's client receives over the event stream. */
export type RoomMessage =
  | {
      type: 'state';
      view: PlayerView;
      /** Events from the action that produced this view (empty on connect). */
      events: GameEvent[];
      you: Color;
      names: Record<Color, string>;
      /** Which seats have a player (the second seat is empty until someone joins). */
      seated: Record<Color, boolean>;
      online: Record<Color, boolean>;
      /** Game number in this room; a rematch starts the next one. */
      game: number;
      rematch: Record<Color, boolean>;
    }
  | { type: 'error'; message: string };

/** A seat in a room, as returned by create and join. */
export interface Seat {
  code: string;
  token: string;
  color: Color;
}
