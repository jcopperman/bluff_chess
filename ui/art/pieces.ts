// Chess pieces drawn as SVG. Colours come from CSS custom properties
// (--fill, --line, --shine) so one drawing serves both sides.

import type { PieceType } from '../../engine/index.ts';

const BASE = '<path class="b" d="M22 91 H78 V85 C78 80.5 74.5 77 70 77 H30 C25.5 77 22 80.5 22 85 Z"/>' +
  '<path class="d" d="M27 84 H73"/>';

const SHAPES: Record<PieceType, string> = {
  pawn:
    '<path class="b" d="M36 77 C38 64 43 55 45 47 H55 C57 55 62 64 64 77 Z"/>' +
    '<rect class="b" x="38" y="42" width="24" height="7" rx="3"/>' +
    '<circle class="b" cx="50" cy="30" r="13"/>' +
    '<path class="s" d="M44 24 A8 8 0 0 1 52 20"/>',
  rook:
    '<path class="b" d="M34 77 L36 44 H64 L66 77 Z"/>' +
    '<path class="b" d="M28 16 H38 V24 H45 V16 H55 V24 H62 V16 H72 V34 C72 38 68 42 64 42 H36 C32 42 28 38 28 34 Z"/>' +
    '<path class="d" d="M36 44 H64 M35 60 H65"/>' +
    '<path class="s" d="M33 22 V32"/>',
  knight:
    '<path class="b" d="M30 77 H70 C71 60 67 45 61 35 C58 28 53 21 45 18 L43 10 L38 19 C30 23 24 33 20 43 C18 49 22 54 27 51 C31 49 35 47 41 45 C41 55 35 65 30 77 Z"/>' +
    '<circle class="e" cx="42" cy="29" r="2.6"/>' +
    '<path class="d" d="M47 21 C56 26 62 36 64 50 M24 47 C27 46 29 46 31 46"/>' +
    '<path class="s" d="M53 28 C58 34 61 42 62 52"/>',
  bishop:
    '<path class="b" d="M42 56 C40 64 36 70 34 77 H66 C64 70 60 64 58 56 Z"/>' +
    '<rect class="b" x="38" y="51" width="24" height="7" rx="3"/>' +
    '<path class="b" d="M50 15 C65 26 67 43 57 51 H43 C33 43 35 26 50 15 Z"/>' +
    '<circle class="b" cx="50" cy="11" r="4.5"/>' +
    '<path class="d" d="M56 27 L47 39"/>' +
    '<path class="s" d="M42 30 C42 26 44 23 47 21"/>',
  queen:
    '<path class="b" d="M34 64 C36 69 34 73 32 77 H68 C66 73 64 69 66 64 Z"/>' +
    '<path class="b" d="M22 30 L32 48 L36 22 L44 45 L50 17 L56 45 L64 22 L68 48 L78 30 L69 62 H31 Z"/>' +
    '<rect class="b" x="31" y="58" width="38" height="7" rx="3"/>' +
    '<circle class="b" cx="22" cy="28" r="4"/><circle class="b" cx="36" cy="20" r="4"/><circle class="b" cx="50" cy="14" r="4.5"/>' +
    '<circle class="b" cx="64" cy="20" r="4"/><circle class="b" cx="78" cy="28" r="4"/>' +
    '<path class="s" d="M36 52 H64"/>',
  king:
    '<path class="b" d="M36 62 C37 68 35 72 32 77 H68 C65 72 63 68 64 62 Z"/>' +
    '<path class="b" d="M31 52 C28 37 38 29 50 29 C62 29 72 37 69 52 Z"/>' +
    '<rect class="b" x="31" y="51" width="38" height="8" rx="3"/>' +
    '<path class="b" d="M46.5 6 H53.5 V12.5 H60 V19.5 H53.5 V29 H46.5 V19.5 H40 V12.5 H46.5 Z"/>' +
    '<path class="s" d="M37 44 C37 38 42 34 48 33"/>',
};

/** Inline SVG for a piece; style with .pc-white / .pc-black on an ancestor. */
export function pieceSVG(type: PieceType): string {
  return `<svg class="piece-svg" viewBox="0 0 100 100" aria-hidden="true">${BASE}${SHAPES[type]}</svg>`;
}
