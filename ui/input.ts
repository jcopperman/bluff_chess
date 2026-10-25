// Input wiring: one set of delegated listeners for the whole app.

export interface InputHandlers {
  action(name: string, data: DOMStringMap, e: MouseEvent): void;
  square(sq: string, e: MouseEvent): void;
  guess(sq: string): void;
  /** Pointing at a piece: mouse hover, or a long press on touch screens. */
  hover(pieceId: string, el: HTMLElement, touch: boolean): void;
  unhover(): void;
  knob(name: string, value: string | boolean): void;
  /** Text typed into a [data-field] input. */
  field(name: string, value: string): void;
  key(key: string, e: KeyboardEvent): void;
}

/** How long a finger rests on a piece before its details show. */
const LONG_PRESS_MS = 450;

export function bindInput(root: HTMLElement, h: InputHandlers): void {
  const closest = (e: Event, sel: string) => (e.target instanceof Element ? e.target.closest<HTMLElement>(sel) : null);

  // Touch: a tap selects as a click does, and a long press on a piece shows its details,
  // since there is no hover. Browsers also fake mouse events after a tap; those are ignored.
  let lastTouch = 0;
  let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  let swallowClick = false;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    lastTouch = Date.now();
    swallowClick = false;
    cancelPress();
    // A new touch outside the details card closes it.
    if (!closest(e, '.tooltip')) h.unhover();
    const pc = closest(e, '[data-piece]');
    if (!pc || pc.closest('.modal')) return;
    press = {
      x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        press = null;
        swallowClick = true;
        h.hover(pc.dataset.piece!, pc, true);
      }, LONG_PRESS_MS),
    };
  });
  root.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  });
  root.addEventListener('pointerup', () => { lastTouch = Date.now(); cancelPress(); });
  root.addEventListener('pointercancel', cancelPress);

  root.addEventListener('click', (e) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const act = closest(e, '[data-act]');
    if (act && !(act instanceof HTMLButtonElement && act.disabled)) {
      h.action(act.dataset.act!, act.dataset, e);
      return;
    }
    const sq = closest(e, '[data-sq]');
    if (sq) h.square(sq.dataset.sq!, e);
  });

  const fromTouch = () => Date.now() - lastTouch < 1000;
  root.addEventListener('contextmenu', (e) => {
    const sq = closest(e, '[data-sq]');
    if (!sq) return;
    e.preventDefault();
    // On touch screens a long press opens the context menu too; the details card handles that.
    if (fromTouch()) return;
    h.guess(sq.dataset.sq!);
  });

  root.addEventListener('mouseover', (e) => {
    if (fromTouch()) return;
    const pc = closest(e, '[data-piece]');
    if (pc) h.hover(pc.dataset.piece!, pc, false);
  });
  root.addEventListener('mouseout', (e) => {
    if (fromTouch()) return;
    const pc = closest(e, '[data-piece]');
    if (pc && !(e.relatedTarget instanceof Node && pc.contains(e.relatedTarget))) h.unhover();
  });

  root.addEventListener('input', (e) => {
    const f = closest(e, '[data-field]');
    if (f instanceof HTMLInputElement) {
      h.field(f.dataset.field!, f.value);
      return;
    }
    const k = closest(e, '[data-knob]');
    if (!k) return;
    const value = k instanceof HTMLInputElement && k.type === 'checkbox' ? k.checked : (k as HTMLInputElement | HTMLSelectElement).value;
    h.knob(k.dataset.knob!, value);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof Element && e.target.matches('input, select, textarea')) return;
    h.key(e.key.toLowerCase(), e);
  });
}
