// Input wiring: one set of delegated listeners for the whole app.

export interface InputHandlers {
  action(name: string, data: DOMStringMap, e: MouseEvent): void;
  square(sq: string, e: MouseEvent): void;
  guess(sq: string): void;
  hover(pieceId: string, el: HTMLElement): void;
  unhover(): void;
  knob(name: string, value: string | boolean): void;
  key(key: string, e: KeyboardEvent): void;
}

export function bindInput(root: HTMLElement, h: InputHandlers): void {
  const closest = (e: Event, sel: string) => (e.target instanceof Element ? e.target.closest<HTMLElement>(sel) : null);

  root.addEventListener('click', (e) => {
    const act = closest(e, '[data-act]');
    if (act && !(act instanceof HTMLButtonElement && act.disabled)) {
      h.action(act.dataset.act!, act.dataset, e);
      return;
    }
    const sq = closest(e, '[data-sq]');
    if (sq) h.square(sq.dataset.sq!, e);
  });

  root.addEventListener('contextmenu', (e) => {
    const sq = closest(e, '[data-sq]');
    if (!sq) return;
    e.preventDefault();
    h.guess(sq.dataset.sq!);
  });

  root.addEventListener('mouseover', (e) => {
    const pc = closest(e, '[data-piece]');
    if (pc) h.hover(pc.dataset.piece!, pc);
  });
  root.addEventListener('mouseout', (e) => {
    const pc = closest(e, '[data-piece]');
    if (pc && !(e.relatedTarget instanceof Node && pc.contains(e.relatedTarget))) h.unhover();
  });

  root.addEventListener('input', (e) => {
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
