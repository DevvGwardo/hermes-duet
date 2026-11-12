export function isIOS(nav: { userAgent?: string; platform?: string; maxTouchPoints?: number }): boolean {
  return /iPhone|iPad|iPod/i.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}
