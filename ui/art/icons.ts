// Small line icons (stroke = currentColor).

const ICONS: Record<string, string> = {
  back: '<path d="M15 5 L8 12 L15 19" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5 L10 17 L19 7" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="1.5" fill="currentColor"/><path d="M8 11 V8 A4 4 0 0 1 16 8 V11" stroke="currentColor" stroke-width="2" fill="none"/>',
};

export function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}
