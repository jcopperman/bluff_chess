// Transient effects layered over the board. The fx layer survives board
// re-renders, so stamps keep playing while the position updates underneath.

interface SquareRect {
  left: number;
  top: number;
  size: number;
}

function squareRect(boardEl: Element, sq: string): SquareRect | null {
  const cell = boardEl.querySelector(`[data-sq="${sq}"]`);
  if (!cell) return null;
  const b = boardEl.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  return { left: c.left - b.left, top: c.top - b.top, size: c.width };
}

export type StampKind = 'lie' | 'true' | 'call';

/** Big stamp over a square: "LIE!", "TRUE", "CALL!". */
export function stamp(fxLayer: Element | null, boardEl: Element | null, sq: string, text: string, kind: StampKind): void {
  if (!fxLayer || !boardEl) return;
  const r = squareRect(boardEl, sq);
  if (!r) return;
  const el = document.createElement('div');
  el.className = `stamp stamp-${kind}`;
  el.textContent = text;
  el.style.left = `${r.left + r.size / 2}px`;
  el.style.top = `${r.top + r.size / 2}px`;
  fxLayer.appendChild(el);
  setTimeout(() => el.remove(), 1700);
  if (kind === 'lie') burst(fxLayer, r, '#ff4d4d');
  if (kind === 'true') burst(fxLayer, r, '#f2c14e');
}

/** Particle burst from a square. */
function burst(fxLayer: Element, r: SquareRect, color: string): void {
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('i');
    p.className = 'particle';
    const angle = (i / 18) * Math.PI * 2;
    const dist = r.size * (0.9 + (i % 3) * 0.35);
    p.style.left = `${r.left + r.size / 2}px`;
    p.style.top = `${r.top + r.size / 2}px`;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.background = color;
    fxLayer.appendChild(p);
    setTimeout(() => p.remove(), 900);
  }
}

export function shake(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 600);
}

export type BannerKind = 'showdown' | 'win' | 'loss' | 'draw';

/** Full-screen dramatic banner (showdowns, results). */
export function banner(text: string, sub: string | null, kind: BannerKind = 'showdown', ms = 2200): Promise<void> {
  const el = document.createElement('div');
  el.className = `banner banner-${kind}`;
  el.innerHTML = `<div class="banner-inner"><div class="banner-title">${text}</div>${sub ? `<div class="banner-sub">${sub}</div>` : ''}</div>`;
  document.body.appendChild(el);
  return new Promise((resolve) => setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.remove(); resolve(); }, 400);
  }, ms));
}

export function chipFly(fromEl: Element | null, toEl: Element | null): void {
  if (!fromEl || !toEl) return;
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const chip = document.createElement('span');
  chip.className = 'chip chip-fly';
  chip.style.left = `${a.left + a.width / 2}px`;
  chip.style.top = `${a.top + a.height / 2}px`;
  chip.style.setProperty('--dx', `${b.left + b.width / 2 - (a.left + a.width / 2)}px`);
  chip.style.setProperty('--dy', `${b.top + b.height / 2 - (a.top + a.height / 2)}px`);
  document.body.appendChild(chip);
  setTimeout(() => chip.remove(), 800);
}
