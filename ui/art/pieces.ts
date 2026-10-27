// Chess pieces drawn as SVG in a linocut style: straight-cut facets, and carved
// wedges (.c) where a print would show the block cut away. Joins (.j) part the
// stacked blocks of a solid black piece. Colours come from CSS custom properties
// (--fill, --line, --cut, --join) so one drawing serves both sides.

import type { PieceType } from '../../engine/index.ts';

const BASE = '<path class="b" d="M24 90 L28 80 H72 L76 90 Z"/><path class="j" d="M30 80 H70"/>';

const SHAPES: Record<PieceType, string> = {
  pawn:
    '<path class="b" d="M37 80 L42 58 H58 L63 80 Z"/>' +
    '<path class="b" d="M36 58 L39 52 H61 L64 58 Z"/>' +
    '<path class="b" d="M44 52 L37 45 V35 L44 27 H56 L63 35 V45 L56 52 Z"/>' +
    '<path class="j" d="M43 58 H57 M40 52 H60"/>' +
    '<path class="c" d="M41 44 L45 32 L44 46 Z M45 63 L48 63 L46 77 Z"/>',
  rook:
    '<path class="b" d="M34 80 L37 44 H63 L66 80 Z"/>' +
    '<path class="b" d="M29 16 H39 V25 H45 V16 H55 V25 H61 V16 H71 L69 38 L64 44 H36 L31 38 Z"/>' +
    '<path class="j" d="M38 44 H62"/>' +
    '<path class="c" d="M41 50 L44 50 L42 75 Z M33 21 L36 21 L35 36 Z"/>',
  knight:
    '<path class="b" d="M32 80 L36 64 L44 52 L30 55 L22 50 L21 43 L33 28 L41 22 L43 11 L50 19 L59 23 L67 36 L71 52 L69 80 Z"/>' +
    '<path class="c" d="M37 34 L44 31 L41 36 Z M53 25 L65 45 L61 46 Z M57 52 L64 74 L60 74 Z M24 46 L30 45 L25 48 Z"/>',
  bishop:
    '<path class="b" d="M40 80 L43 60 H57 L60 80 Z"/>' +
    '<path class="b" d="M35 60 L38 53 H62 L65 60 Z"/>' +
    '<path class="b" d="M38 53 L35 38 L50 15 L65 38 L62 53 Z"/>' +
    '<path class="b" d="M50 4 L55 9.5 L50 15 L45 9.5 Z"/>' +
    '<path class="j" d="M44 60 H56 M39 53 H61"/>' +
    '<path class="c" d="M55 24 L58 29 L47 42 L46 38 Z M40 40 L45 30 L42 45 Z M45 64 L48 64 L46 77 Z"/>',
  queen:
    '<path class="b" d="M37 80 L40 64 H60 L63 80 Z"/>' +
    '<path class="b" d="M31 64 L34 57 H66 L69 64 Z"/>' +
    '<path class="b" d="M34 57 L24 31 L37 44 L39 25 L46 42 L50 20 L54 42 L61 25 L63 44 L76 31 L66 57 Z"/>' +
    '<path class="b" d="M24 22 L28 27 L24 32 L20 27 Z M39 16 L43 21 L39 26 L35 21 Z M50 10 L54 15 L50 20 L46 15 Z' +
    ' M61 16 L65 21 L61 26 L57 21 Z M76 22 L80 27 L76 32 L72 27 Z"/>' +
    '<path class="j" d="M41 64 H59 M35 57 H65"/>' +
    '<path class="c" d="M31 40 L37 51 L34 52 Z M45 67 L48 67 L46 77 Z"/>',
  king:
    '<path class="b" d="M37 80 L40 62 H60 L63 80 Z"/>' +
    '<path class="b" d="M32 62 L35 54 H65 L68 62 Z"/>' +
    '<path class="b" d="M35 54 L31 42 L40 31 H60 L69 42 L65 54 Z"/>' +
    '<path class="b" d="M46 6 H54 V12 H60 V19 H54 V31 H46 V19 H40 V12 H46 Z"/>' +
    '<path class="j" d="M41 62 H59 M36 54 H64 M47 31 H53"/>' +
    '<path class="c" d="M37 46 L45 35 L40 47 Z M44 66 L47 66 L45 77 Z"/>',
};

/** Inline SVG for a piece; style with .pc-white / .pc-black on an ancestor. */
export function pieceSVG(type: PieceType): string {
  return `<svg class="piece-svg" viewBox="0 0 100 100" aria-hidden="true">${BASE}${SHAPES[type]}</svg>`;
}
