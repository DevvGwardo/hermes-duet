import { useEffect, useRef, type RefObject } from 'react';

const TABBABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      !(el as HTMLButtonElement).disabled &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden',
  );
}

// The control the user last interacted with: pointer and keyboard events update it across both main UI
// and parent dialogs, so closing a nested dialog hands focus back inside its parent rather than jumping outside.
let lastInteracted: HTMLElement | null = null;

/** Call once from the app root: remembers the last interacted element for dialog opener focus restoration. */
export function trackDialogOpeners(): () => void {
  const onDown = (e: Event) => {
    // SVG icons are Elements but not HTMLElements: a click on a button's glyph must still count as touching the button.
    if (e.target instanceof Element) lastInteracted = e.target as HTMLElement;
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onDown, true);
  return () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onDown, true);
  };
}

function dialogZ(el: HTMLElement): number {
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    const z = Number.parseInt(getComputedStyle(cur).zIndex, 10);
    if (Number.isFinite(z)) return z;
  }
  return 0;
}

/** True when `root` is the topmost visible dialog/sheet/overlay (highest z-index, then later DOM order). */
export function isTopDialog(root: HTMLElement | null): boolean {
  if (!root || !root.isConnected) return false;
  const dialogs = [...document.querySelectorAll<HTMLElement>('.sheet, .browser-pane')].filter(
    (el) => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  );
  if (!dialogs.length) return false;
  let top = dialogs[0];
  let topZ = dialogZ(top);
  for (let i = 1; i < dialogs.length; i++) {
    const d = dialogs[i];
    const z = dialogZ(d);
    if (z >= topZ) {
      top = d;
      topZ = z;
    }
  }
  return top === root;
}

function resolveOpener(root: HTMLElement): HTMLElement | null {
  const candidates: (Element | null)[] = [
    lastInteracted && lastInteracted.isConnected && !root.contains(lastInteracted) ? lastInteracted : null,
    document.activeElement && document.activeElement !== document.body && !root.contains(document.activeElement)
      ? document.activeElement
      : null,
  ];
  for (const raw of candidates) {
    if (!raw || !raw.isConnected || root.contains(raw)) continue;
    const viaAncestor = (raw.closest(TABBABLE) ?? null) as HTMLElement | null;
    for (const c of [raw as HTMLElement, viaAncestor]) {
      if (!c || root.contains(c) || !c.isConnected) continue;
      if ((c as HTMLButtonElement).disabled) continue;
      if (c.matches(TABBABLE) || c.tabIndex >= 0) return c;
    }
  }
  return null;
}

/**
 * Keep keyboard focus inside the topmost open dialog: move focus in on open, wrap Tab at the edges,
 * handle Escape via `onEscape` (return `false` to pass through), and restore focus to the opener on close.
 */
export function useDialogTrap(ref: RefObject<HTMLElement | null>, onEscape?: (e: KeyboardEvent) => boolean | void) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Snapshot the opener at mount so nested dialogs opening later cannot clobber the parent's opener.
    const opener = resolveOpener(root);
    // Let the dialog paint first; leave focus alone when a child (e.g. an autoFocus input) already claimed it.
    const t = requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) tabbables(root)[0]?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (!isTopDialog(root)) return;
      if (e.key === 'Escape' && onEscapeRef.current) {
        if (onEscapeRef.current(e) === false) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key !== 'Tab') return;
      const at = document.activeElement as HTMLElement | null;
      const stops = tabbables(root);
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!root.contains(at)) {
        // Focus never entered (or slipped out through an iframe): pull it back.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(t);
      window.removeEventListener('keydown', onKey, true);
      if (!opener || !opener.isConnected || root.contains(opener)) return;
      const viaAncestor = (opener.closest(TABBABLE) ?? null) as HTMLElement | null;
      for (const c of [opener, viaAncestor]) {
        if (!c || root.contains(c) || !c.isConnected) continue;
        c.focus();
        if (document.activeElement === c) break;
      }
    };
  }, [ref]);
}
