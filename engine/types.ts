// Shared engine types. The full game state is plain JSON: it doubles as the save format.

export type Color = 'white' | 'black';
export type ClaimType = 'rook' | 'knight' | 'bishop' | 'queen';
export type PieceType = ClaimType | 'king' | 'pawn';
/** Algebraic square, e.g. "e4". */
export type Square = string;
export type Phase = 'setup' | 'move' | 'callWindow' | 'defendWindow' | 'showdown' | 'over';
/** Seven types for back-rank files a, b, c, d, f, g, h. */
export type Arrangement = ClaimType[];

export interface Piece {
  id: string;
  owner: Color;
  /** null in a player view for the opponent's face-down pieces (and before setup). */
  type: PieceType | null;
  square: Square | null;
  faceUp: boolean;
  claim: ClaimType | null;
  hasMoved: boolean;
  captured: boolean;
  promoted: boolean;
  /** Removed for being caught lying. */
  removed: boolean;
}

export interface Config {
  startingChips: number;
  claimLocking: boolean;
  chipsOutLoss: boolean;
  liarPaysChip: boolean;
  /** 0 = unlimited while chips last. */
  showdownsPerMate: number;
  repetition: boolean;
  fiftyMove: boolean;
}

/** A piece in a custom starting position; omitted flags take their defaults. */
export type PieceInit = Pick<Piece, 'id' | 'owner' | 'square'> & { type: PieceType } & Partial<Omit<Piece, 'id' | 'owner' | 'square' | 'type'>>;

export interface GameConfig extends Partial<Config> {
  setups?: Partial<Record<Color, Arrangement>>;
  /** Custom position (tests, puzzles). Skips setup. */
  pieces?: PieceInit[];
  turn?: Color;
  chips?: Partial<Record<Color, number>>;
  ep?: Square | null;
}

export interface PendingCastle {
  side: 'K' | 'Q';
  kingId: string;
  kingFrom: Square;
  kingTo: Square;
  kingPrevHasMoved: boolean;
}

/** A face-down move held open during the call window, with everything needed to undo it. */
export interface Pending {
  mover: Color;
  action: { from: Square; to: Square; claim: ClaimType | null; promotion: ClaimType | null };
  /** The claiming piece (the corner piece when castling). */
  pieceId: string;
  from: Square;
  to: Square;
  claim: ClaimType | null;
  /** Stripped from the opponent's view. */
  honest?: boolean | null;
  prevClaim: ClaimType | null;
  prevHasMoved: boolean;
  capturedId: string | null;
  capturedSquare: Square | null;
  castle: PendingCastle | null;
  prevEp: Square | null;
  claimIndex: number | null;
  /** A king move held open for a defend: the opponent's unclaimed cards that could reach its square. */
  defenders?: string[];
}

export type ClaimOutcome = 'pending' | 'passed' | 'caught' | 'confirmed';

export interface ClaimRecord {
  fullmove: number;
  player: Color;
  pieceId: string;
  from: Square;
  to: Square;
  claim: ClaimType;
  /** Stripped from the opponent's view while the piece is still face-down. */
  honest?: boolean | null;
  called: boolean;
  outcome: ClaimOutcome;
  castle: boolean;
  capture: boolean;
}

export interface ShowdownRecord {
  fullmove: number;
  player: Color;
  pieceId: string;
  claim: ClaimType;
  honest: boolean;
  square: Square | null;
}

export type ResultReason = 'checkmate' | 'stalemate' | 'resign' | 'chips' | 'repetition' | 'fiftyMove' | 'insufficientMaterial';

export interface Result {
  winner: Color | null;
  reason: ResultReason;
}

export interface GameState {
  turn: Color;
  phase: Phase;
  pieces: Piece[];
  chips: Record<Color, number>;
  pending: Pending | null;
  ep: Square | null;
  halfmove: number;
  fullmove: number;
  positions: Record<string, number>;
  claims: ClaimRecord[];
  showdowns: ShowdownRecord[];
  history: Action[];
  setupDone: Record<Color, boolean>;
  mateShowdowns: number;
  result: Result | null;
  revealed: boolean;
  config: Config;
}

/** Same shape as the state, with the viewer's opponent's hidden information stripped. */
export interface PlayerView extends GameState {
  viewer: Color;
}

// ---------------------------------------------------------------------------
// Actions

/** `arrangement` is stripped from the opponent's view of the history. */
export interface SetupAction { type: 'setup'; player: Color; arrangement?: Arrangement }
export interface MoveAction { type: 'move'; player: Color; from: Square; to: Square; claim?: ClaimType; promotion?: ClaimType }
export interface CallAction { type: 'call'; player: Color }
export interface PassAction { type: 'pass'; player: Color }
/** Flip an unclaimed card that really attacks the square the enemy king just moved to. */
export interface DefendAction { type: 'defend'; player: Color; pieceId: string }
export interface ShowdownAction { type: 'showdown'; player: Color; targetPieceId: string }
export interface AcceptMateAction { type: 'acceptMate'; player: Color }
export interface ResignAction { type: 'resign'; player: Color }

export type Action = SetupAction | MoveAction | CallAction | PassAction | DefendAction | ShowdownAction | AcceptMateAction | ResignAction;

// ---------------------------------------------------------------------------
// Events (for the UI and logs)

export type GameEvent =
  | { type: 'setupDone'; player: Color }
  | {
      type: 'moved'; player: Color; pieceId: string; from: Square; to: Square;
      claim: ClaimType | null; capturedId: string | null; castle: 'K' | 'Q' | null; promotion: ClaimType | null;
    }
  | { type: 'claimMade'; player: Color; pieceId: string; claim: ClaimType; square: Square }
  | { type: 'callWindowOpened'; player: Color; pieceId: string }
  | { type: 'passed'; player: Color; pieceId: string }
  | { type: 'called'; player: Color; pieceId: string }
  | {
      type: 'lieCaught'; pieceId: string; pieceType: PieceType; claim: ClaimType; square: Square;
      liar: Color; caller: Color; from?: Square; restoredId?: string | null; showdown?: boolean;
      /** The liar paid the caller a chip. */
      paid?: boolean;
      /** Undoing the lie left the liar in check, so they must move again (or are mated). */
      stillInCheck?: boolean;
    }
  | {
      type: 'claimConfirmed'; pieceId: string; pieceType: PieceType; square: Square;
      mover: Color; caller: Color; showdown?: boolean;
    }
  | { type: 'defendWindowOpened'; player: Color; kingId: string; square: Square; defenders: string[] }
  | {
      type: 'defended'; player: Color; pieceId: string; pieceType: PieceType; square: Square;
      mover: Color; kingFrom: Square; kingTo: Square; restoredId: string | null;
      /** The king's player paid the defender a chip. */
      paid: boolean;
      /** Undoing the king move left it in check, so its player moves again (or is mated). */
      stillInCheck: boolean;
    }
  | { type: 'defenseFailed'; player: Color; pieceId: string; pieceType: PieceType; square: Square; mover: Color; kingTo: Square }
  | { type: 'pieceRevealed'; pieceId: string; pieceType: PieceType }
  | {
      type: 'captured'; pieceId: string; pieceType: PieceType; owner: Color; square: Square;
      by: Color; claim: ClaimType | null;
    }
  | { type: 'check'; player: Color }
  | { type: 'showdownAvailable'; player: Color }
  | { type: 'showdown'; player: Color; pieceId: string; claim: ClaimType; square: Square }
  | { type: 'mateBroken'; player: Color }
  | { type: 'gameOver'; winner: Color | null; reason: ResultReason };

export type EventType = GameEvent['type'];

// ---------------------------------------------------------------------------
// Boards (see moves.ts)

/** One square of a board: the apparent board, or the bot's search board. */
export interface Cell {
  id: string;
  color: Color;
  /** Apparent type; null for an unclaimed face-down piece (blocks lines, attacks nothing). */
  type: PieceType | null;
  hidden: boolean;
  claim: ClaimType | null;
  hasMoved: boolean;
  /** Search-board valuation override (bot only). */
  value?: number;
}

/** 64 cells, index = rank * 8 + file (a1 = 0, h8 = 63). */
export type Board = (Cell | null)[];

/** Internal move on a board, by square index. */
export interface Move {
  from: number;
  to: number;
  /** Type the piece moves as. */
  type: PieceType;
  claim?: ClaimType;
  promo?: ClaimType;
  castle?: { side: 'K' | 'Q'; rookFrom: number; rookTo: number };
  ep?: boolean;
  double?: boolean;
}
