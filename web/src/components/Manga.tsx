// Hermes Duet visual language: the hermes-agent ink girl, a gold pixel wordmark,
// halftone screentone and manga focus lines that speed up while the agent works.
import { useEffect, useState } from 'react';

/** The hermes-agent mark: ink girl on a paper squircle. `live` adds focus lines around it. */
export function BrandBadge({ size = 36, live = false }: { size?: number; live?: boolean }) {
  return (
    <span className={`badge-mark ${live ? 'live' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <img src="/mascot-black.svg" alt="" draggable={false} />
    </span>
  );
}

/** "HERMES DUET" in the banner's banded-gold pixel style. */
export function Wordmark({
  stacked = false,
  size = 'md',
  decode = false,
}: {
  stacked?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Scramble-decode the letters on a loop (pair screen taste). Static everywhere else. */
  decode?: boolean;
}) {
  return (
    <span className={`wordmark wm-${size} ${stacked ? 'stacked' : ''}`} aria-label="Hermes Duet">
      {decode ? (
        <>
          <Decode className="wm-hermes" text="HERMES" attr="data-text" speed={110} loopMs={15000} />
          <Decode className="wm-duet" text="DUET" speed={110} delay={600} loopMs={15000} />
        </>
      ) : (
        <>
          <span className="wm-hermes" data-text="HERMES">
            HERMES
          </span>
          <span className="wm-duet">DUET</span>
        </>
      )}
    </span>
  );
}

/**
 * Scramble-decode text: glyphs churn left to right until the true letters land,
 * then (optionally) the whole thing re-runs on a loop. Stays in the pixel font,
 * which is monospace, so nothing reflows mid-scramble. Static text under
 * prefers-reduced-motion; screen readers get the plain string, never the churn.
 */
const DECODE_GLYPHS = '/\\|[]{}<>+*#?$%&@';

export function Decode({
  text,
  className,
  speed = 70,
  delay = 0,
  loopMs,
  hold = 4,
  /** Mirror the live string onto an attribute too (the wordmark's band echo reads data-text). */
  attr,
}: {
  text: string;
  className?: string;
  /** ms per letter before it starts churning. */
  speed?: number;
  /** ms to wait before the first run. */
  delay?: number;
  /** ms to hold the decoded string before re-running; omit for once. */
  loopMs?: number;
  /** animation frames each churned glyph stays up; higher is calmer. */
  hold?: number;
  attr?: string;
}) {
  const [out, setOut] = useState(() => text.replace(/[^\s]/g, ' '));
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setOut(text);
      return;
    }
    let alive = true;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const glyphs: string[] = new Array(text.length).fill(' ');
    const run = () => {
      const begun = performance.now() + delay;
      const settle = 520;
      const total = delay + text.length * speed + settle;
      let frame = 0;
      const tick = (now: number) => {
        if (!alive) return;
        const t = now - begun;
        if (t < 0) {
          raf = requestAnimationFrame(tick);
          return;
        }
        frame++;
        const reroll = frame % hold === 0;
        let s = '';
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === ' ') {
            s += ' ';
            continue;
          }
          const at = i * speed;
          if (t >= at + settle) s += ch;
          else if (t >= at) {
            if (reroll || glyphs[i] === ' ') glyphs[i] = DECODE_GLYPHS[(Math.random() * DECODE_GLYPHS.length) | 0];
            s += glyphs[i];
          } else s += ' ';
        }
        setOut(s);
        if (t < total) raf = requestAnimationFrame(tick);
        else {
          setOut(text);
          if (loopMs != null) timer = setTimeout(() => alive && run(), loopMs);
        }
      };
      raf = requestAnimationFrame(tick);
    };
    run();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [text, speed, delay, loopMs, hold]);
  const props = { className, 'aria-hidden': true as const, ...(attr ? { [attr]: out } : {}) };
  return (
    <>
      <span {...props}>{out}</span>
      <span className="sr-only">{text}</span>
    </>
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
