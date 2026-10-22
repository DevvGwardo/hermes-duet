// Hermes Duet visual language: the hermes-agent ink girl, a gold pixel wordmark,
// halftone screentone and manga focus lines that speed up while the agent works.

/** The hermes-agent mark: ink girl on a paper squircle. `live` adds focus lines around it. */
export function BrandBadge({ size = 36, live = false }: { size?: number; live?: boolean }) {
  return (
    <span className={`badge-mark ${live ? 'live' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <img src="/mascot-black.svg" alt="" draggable={false} />
    </span>
  );
}

/** "HERMES DUET" in the banner's banded-gold pixel style. */
export function Wordmark({ stacked = false, size = 'md' }: { stacked?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`wordmark wm-${size} ${stacked ? 'stacked' : ''}`} aria-label="Hermes Duet">
      <span className="wm-hermes" data-text="HERMES">
        HERMES
      </span>
      <span className="wm-duet">DUET</span>
    </span>
  );
}

/** Large mascot portrait (white ink, for dark backgrounds) inside a halftone moon. */
export function Mascot({ size = 180, live = false }: { size?: number; live?: boolean }) {
  return (
    <div className={`mascot ${live ? 'live' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="mascot-tone" />
      <span className="mascot-lines" />
      <img src="/mascot-white.svg" alt="" draggable={false} />
    </div>
  );
}

export function SpeechBubble({ children, side = 'left' }: { children: React.ReactNode; side?: 'left' | 'top' }) {
  return <div className={`speech speech-${side}`}>{children}</div>;
}

/** Fixed page backdrop: ink, two halftone corners, focus lines. `stirred` = agent working. */
export function MangaBackdrop({ stirred }: { stirred: boolean }) {
  return (
    <div className={`backdrop ${stirred ? 'stirred' : ''}`} aria-hidden="true">
      <span className="tone tone-a" />
      <span className="tone tone-b" />
      <span className="focus-lines" />
      <span className="vignette" />
    </div>
  );
}
