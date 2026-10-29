import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

marked.setOptions({ gfm: true, breaks: true });

// Links in agent replies open outside the app; following one in place would navigate the PWA away. An in-page
// anchor (#section) stays in place, since a new tab would land at the top of a different document.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const href = node.tagName === 'A' ? node.getAttribute('href') : null;
  if (href && !href.startsWith('#')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Agent text can come from a page the agent read, so it is treated as untrusted HTML. Scripts and handlers are
 * stripped by default, but DOMPurify's allowlist keeps `style`, `class` and form controls, which is enough to
 * draw a full-screen overlay over the app, or post to a bodyless route (stop the run, cancel a task) via a form.
 * `src` is left alone: images in replies are a supported thing to show.
 */
const SANITIZE = {
  ADD_ATTR: ['target'],
  FORBID_ATTR: ['style', 'class', 'id'],
  FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'fieldset', 'legend', 'label', 'style'],
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, SANITIZE);
  }, [text]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function timeLabel(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function relLabel(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function bytesLabel(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type IconProps = { size?: number; className?: string };
const svg = (path: React.ReactNode) =>
  function Icon({ size = 20, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };

export const Icon = {
  chat: svg(<path d="M4 5h16v11H9l-5 4z" />),
  tasks: svg(
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17" />
    </>,
  ),
  make: svg(
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <path d="M16.5 13.5v6M13.5 16.5h6" />
    </>,
  ),
  send: svg(<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />),
  down: svg(<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" />),
  stop: svg(<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />),
  mic: svg(
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>,
  ),
  globe: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </>,
  ),
  gear: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>,
  ),
  close: svg(<path d="M6 6l12 12M18 6 6 18" />),
  check: svg(<path d="m5 12.5 4.5 4.5L19 7.5" />),
  chevron: svg(<path d="m9 6 6 6-6 6" />),
  file: svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>,
  ),
  deck: svg(
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4M8 20h8" />
    </>,
  ),
  sheet: svg(
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 10h16M4 15h16M10 4v16" />
    </>,
  ),
  chart: svg(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  doc: svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>,
  ),
  image: svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </>,
  ),
  sun: svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>,
  ),
  bolt: svg(<path d="M13 3 5 14h6l-1 7 8-11h-6z" />),
  search: svg(
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>,
  ),
  camera: svg(
    <>
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </>,
  ),
  attach: svg(<path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.2 3.2 0 0 1 4.5 4.5L9.5 17a1.6 1.6 0 0 1-2.3-2.3L15 7" />),
  play: svg(<path d="M8 5.5v13l11-6.5z" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  hash: svg(<path d="M9 4 7.5 20M16.5 4 15 20M4 9h16M3 15h16" />),
  speaker: svg(
    <>
      <path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" />
      <path d="M15 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />
    </>,
  ),
  key: svg(
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M15.5 12v2.5" />
    </>,
  ),
  phone: svg(
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 5.5h2" />
    </>,
  ),
  archive: svg(
    <>
      <path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M3 4.5h18V8H3zM10 12h4" />
    </>,
  ),
};

export function fileIcon(mime: string, name: string) {
  if (mime.startsWith('image/')) return Icon.image;
  if (/presentation|pptx|key$/.test(mime + name) || /deck|slides/i.test(name)) return Icon.deck;
  if (/sheet|csv|excel|xlsx/.test(mime + name)) return Icon.sheet;
  if (/dashboard/i.test(name)) return Icon.chart;
  if (/html|markdown|pdf|text|word|docx/.test(mime + name)) return Icon.doc;
  return Icon.file;
}
