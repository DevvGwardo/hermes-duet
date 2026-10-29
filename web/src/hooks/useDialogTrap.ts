import { useEffect, type RefObject } from 'react';

const TABBABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Visible, enabled tab stops inside the container, in DOM order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      !(el as HTMLButtonElement).disabled &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden',
  );
}

// The control the user touched before a dialog opened: pointer and keyboard
// events outside any dialog keep it current, so closing a dialog can hand
// focus back to its opener even when the dialog stole focus on open
// (autoFocus) or was opened from the keyboard.
let lastOutside: HTMLElement | null = null;

function isInsideDialog(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && !!t.closest?.('.sheet,.browser-pane');
}

/** Call once from the app root: remembers the last interacted control outside dialogs. */
export function trackDialogOpeners(): () => void {
  const onDown = (e: Event) => {
    // SVG icons are Elements but not HTMLElements: a click on a button's
    // glyph must still count as touching the button.
    if (!isInsideDialog(e.target) && e.target instanceof Element) lastOutside = e.target as HTMLElement;
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onDown, true);
  return () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onDown, true);
  };
}

/**
 * Keep keyboard focus inside an open dialog: move focus in on open, wrap Tab
 * at the edges, and hand focus back to the opener on close. Escape handling
 * stays with each dialog (some swallow it, e.g. the viewer iframe).
 */
export function useDialogTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Let the dialog paint first; leave focus alone when a child (e.g. the
    // search input's autoFocus) already claimed it.
    const t = requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) tabbables(root)[0]?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const stops = tabbables(root);
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement as HTMLElement | null;
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
      // Hand focus back to the control that opened the dialog. The recorded
      // target is often a child (icon, label text) rather than the control
      // itself, so escalate to the nearest focusable ancestor when focusing
      // it does not take. Mount-time activeElement is useless here: the
      // dialog may have stolen focus on open (autoFocus).
      const out = lastOutside && !root.contains(lastOutside) && lastOutside.isConnected ? lastOutside : null;
      const viaAncestor = (out?.closest('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? null) as HTMLElement | null;
      for (const c of [out, viaAncestor]) {
        if (!c || root.contains(c) || !c.isConnected) continue;
        (c as HTMLElement).focus();
        if (document.activeElement === c) break;
      }
    };
  }, [ref]);
}
