// Transient effects layered over the board. The fx layer survives board
// re-renders, so stamps keep playing while the position updates underneath.

interface SquareRect {
  left: number;
  top: number;
  size: number;
}

/** Ratio of on-screen size to layout size (the stage is CSS-scaled to fit the window). */
export function stageScale(el: HTMLElement): number {
  return el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
}

/** A square's position in the board's own (unscaled) coordinates. */
function squareRect(boardEl: HTMLElement, sq: string): SquareRect | null {
  const cell = boardEl.querySelector(`[data-sq="${sq}"]`);
  if (!cell) return null;
  const k = stageScale(boardEl);
  const b = boardEl.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  return { left: (c.left - b.left) / k, top: (c.top - b.top) / k, size: c.width / k };
}

export type StampKind = 'lie' | 'true' | 'call' | 'pass';

/** A rubber stamp over a square: "Liar", "True", "Called". */
export function stamp(fxLayer: Element | null, boardEl: HTMLElement | null, sq: string, text: string, kind: StampKind): void {
  if (!fxLayer || !boardEl) return;
  const r = squareRect(boardEl, sq);
  if (!r) return;
  fxLayer.querySelectorAll('.stamp').forEach((old) => old.remove());
  const el = document.createElement('div');
  el.className = `stamp stamp-${kind}`;
  el.textContent = text;
  el.style.left = `${r.left + r.size / 2}px`;
  el.style.top = `${r.top + r.size / 2}px`;
  fxLayer.appendChild(el);
  setTimeout(() => el.remove(), 1600);
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

/** Positions of pieces on the board, keyed by piece id, before a re-render. */
export function snapshotPieces(boardEl: HTMLElement): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>();
  boardEl.querySelectorAll<HTMLElement>('[data-piece]').forEach((el) => out.set(el.dataset.piece!, el.getBoundingClientRect()));
  return out;
}

/** After a re-render, slide each piece from its old position (FLIP). */
export function slidePieces(boardEl: HTMLElement, before: Map<string, DOMRect>, ms = 240): void {
  const k = stageScale(boardEl);
  boardEl.querySelectorAll<HTMLElement>('[data-piece]').forEach((el) => {
    const old = before.get(el.dataset.piece!);
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dx = (old.left - now.left) / k, dy = (old.top - now.top) / k;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 5 }, { transform: 'none', zIndex: 5 }], { duration: ms, easing: 'cubic-bezier(.3,.8,.3,1)' });
  });
}
