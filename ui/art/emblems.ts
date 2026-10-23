// Character emblems for the opponent cards, drawn as engraved line work in
// ink (currentColor) with a red accent (--red). No faces: characters react
// through the card itself (see .card-mood-* in styles.css).

export type Mood = 'neutral' | 'smug' | 'nervous' | 'caught' | 'triumphant' | 'thinking';

const P = 'var(--paper)';
const R = 'var(--red)';

function hatch(id: string, angle = 45, gap = 4): string {
  return `<pattern id="${id}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})">` +
    `<line x1="0" y1="0" x2="0" y2="${gap}" stroke="currentColor" stroke-width="1.2"/></pattern>`;
}

function mirror(d: string): string {
  return d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${120 - Number(x)} ${y}`);
}

const EMBLEMS: Record<string, (h: string) => string> = {
  // Professor Fumble: an open book and spectacles.
  tutor: (h) => {
    const left = 'M60 76 C46 68 28 68 14 74 L14 130 C28 124 46 124 60 132 Z';
    return `<path d="${left}" fill="${P}" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="${mirror(left)}" fill="url(#${h})" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M22 88 C32 84 44 84 52 88 M22 98 C32 94 44 94 52 98 M22 108 C32 104 44 104 52 108" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <circle cx="42" cy="44" r="14" fill="none" stroke="currentColor" stroke-width="4"/>
      <circle cx="78" cy="44" r="14" fill="none" stroke="currentColor" stroke-width="4"/>
      <path d="M56 44 Q60 37 64 44 M28 42 L14 36 M92 42 L106 36" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M60 132 V146" stroke="${R}" stroke-width="5"/>`;
  },
  // The Deacon: a cross in a burst of rays.
  deacon: () => {
    let rays = '';
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r1 = 30, r2 = i % 2 ? 46 : 54;
      rays += `M${(60 + Math.cos(a) * r1).toFixed(1)} ${(66 + Math.sin(a) * r1).toFixed(1)} L${(60 + Math.cos(a) * r2).toFixed(1)} ${(66 + Math.sin(a) * r2).toFixed(1)} `;
    }
    return `<path d="${rays}" stroke="currentColor" stroke-width="1.6"/>
      <path d="M53 16 H67 V50 H90 V64 H67 V132 H53 V64 H30 V50 H53 Z" fill="currentColor"/>
      <path d="M60 22 V126 M36 57 H84" stroke="${P}" stroke-width="1.6"/>
      <circle cx="60" cy="57" r="5" fill="${R}"/>
      <path d="M36 140 H84" stroke="currentColor" stroke-width="3"/>`;
  },
  // Marlowe: a comedy mask with ribbons.
  marlowe: (h) => {
    const eye = 'M36 58 Q44 49 53 58 Q44 63 36 58 Z';
    return `<path d="M24 64 C14 70 12 86 4 96" stroke="${R}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="${mirror('M24 64 C14 70 12 86 4 96')}" stroke="${R}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="M22 40 C22 24 98 24 98 40 C98 88 82 124 60 130 C38 124 22 88 22 40 Z" fill="currentColor"/>
      <path d="M78 34 C92 40 94 70 86 96 C82 110 74 120 66 124 C80 104 86 70 78 34 Z" fill="url(#${h})" opacity="0.7"/>
      <path d="${eye}" fill="${P}"/><path d="${mirror(eye)}" fill="${P}"/>
      <path d="M34 48 Q44 40 54 47 M66 47 Q76 40 86 48" stroke="${P}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path d="M38 88 Q60 112 82 88 Q60 99 38 88 Z" fill="${P}"/>`;
  },
  // Pip: an acorn.
  pip: (h) => `<path d="M60 44 C60 32 67 23 77 19" stroke="currentColor" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      <path d="M32 68 C30 98 46 126 60 136 C74 126 90 98 88 68 Z" fill="${P}" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>
      <path d="M70 70 C86 74 86 102 66 130 C78 110 82 90 74 70 Z" fill="url(#${h})"/>
      <path d="M44 78 C44 92 48 104 54 114" stroke="currentColor" stroke-width="1.6" fill="none"/>
      <path d="M24 64 C24 40 96 40 96 64 C96 73 24 73 24 64 Z" fill="currentColor"/>
      <path d="M32 54 L40 62 M44 48 L54 60 M58 46 L68 60 M72 48 L80 60 M84 54 L90 61" stroke="${P}" stroke-width="1.6"/>
      <path d="M60 136 V146" stroke="${R}" stroke-width="5"/>`,
  // Sable: a fox's head.
  sable: () => {
    const ear = 'M32 30 L46 50 L36 55 Z';
    const eye = 'M39 68 L53 74 L42 75 Z';
    return `<path d="M60 132 L20 64 L28 18 L50 46 L70 46 L92 18 L100 64 Z" fill="currentColor"/>
      <path d="${ear}" fill="${R}"/><path d="${mirror(ear)}" fill="${R}"/>
      <path d="M60 132 L34 78 L60 90 L86 78 Z" fill="${P}"/>
      <path d="${eye}" fill="${P}"/><path d="${mirror(eye)}" fill="${P}"/>
      <path d="M54 122 H66 L60 132 Z" fill="currentColor"/>
      <path d="M60 96 V118" stroke="currentColor" stroke-width="1.5"/>`;
  },
  // The Widow: a spider on a thread.
  widow: () => {
    const legs = 'M51 58 L30 40 L18 54 M50 62 L26 60 L10 76 M51 67 L28 78 L18 100 M53 71 L37 94 L33 120';
    const hourglass = 'M53 84 L67 84 L60 94 L67 104 L53 104 L60 94 Z';
    return `<path d="M60 4 V48" stroke="currentColor" stroke-width="1.6"/>
      <path d="${legs}" stroke="currentColor" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${mirror(legs)}" stroke="currentColor" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="60" cy="94" rx="22" ry="27" fill="currentColor"/>
      <ellipse cx="60" cy="60" rx="12" ry="11" fill="currentColor"/>
      <path d="${hourglass}" fill="${R}"/>`;
  },
};

/** Inline SVG emblem for a character. Unknown ids get a plain diamond. */
export function emblemSVG(id: string): string {
  const h = `hatch-${id}`;
  const draw = EMBLEMS[id] ?? (() => '<path d="M60 20 L96 75 L60 130 L24 75 Z" fill="currentColor"/>');
  return `<svg class="emblem-svg" viewBox="0 0 120 150" aria-hidden="true"><defs>${hatch(h)}</defs>${draw(h)}</svg>`;
}

/** Tarot-style numeral for a character's card. */
export function numeral(n: number): string {
  return n === 0 ? '0' : ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] ?? String(n);
}
