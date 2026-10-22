import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Item } from '../../../shared/types';
import { loadOlder } from '../api';
import { useStore } from '../store';
import { Icon, Markdown, dayLabel, timeLabel } from '../ui';
import { CardView } from './CardView';
import { BrandBadge, Mascot, SpeechBubble } from './Manga';

const SUGGESTIONS = [
  'What’s on my plate today?',
  'What should I follow up on this week?',
  'Build me a dashboard for this week',
  'Draft a reply to my most urgent email',
];

export function Thread({ onOpenFile, scrollToId, onSuggest }: { onOpenFile: (id: string) => void; scrollToId?: string | null; onSuggest: (text: string) => void }) {
  const items = useStore((s) => s.items);
  const hasMore = useStore((s) => s.hasMore);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [loading, setLoading] = useState(false);
  const lastLen = useRef(0);

  // Follow the bottom while the user is already there (new items and streaming text).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    lastLen.current = items.length;
  }, [items]);

  useEffect(() => {
    if (!scrollToId) return;
    const el = document.getElementById(`item-${scrollToId}`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
  }, [scrollToId]);

  function onScroll() {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function older() {
    const el = ref.current!;
    const prevHeight = el.scrollHeight;
    setLoading(true);
    try {
      await loadOlder();
    } finally {
      setLoading(false);
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight - prevHeight));
    }
  }

  if (!items.length) {
    return (
      <div className="thread empty" ref={ref}>
        <div className="empty-state">
          <div className="empty-hero">
            <Mascot size={190} />
            <SpeechBubble>
              <strong>Hand me something.</strong> I'll work on it in the background, ask before anything sensitive, and check in each morning.
            </SpeechBubble>
          </div>
          <div className="suggestions">
            {SUGGESTIONS.map((q) => (
              <button key={q} className="suggestion" onClick={() => onSuggest(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  let lastDay = '';
  return (
    <div className="thread" ref={ref} onScroll={onScroll}>
      {hasMore && (
        <button className="load-older" onClick={older} disabled={loading}>
          {loading ? 'Loading…' : 'Earlier messages'}
        </button>
      )}
      {items.map((item, i) => {
        const day = dayLabel(item.created_at);
        const sep = day !== lastDay;
        lastDay = day;
        const prev = items[i - 1];
        // One avatar per run of consecutive replies, like a manga speaker.
        const avatar = sep || !prev || prev.kind !== 'assistant' || prev.run_id !== item.run_id;
        return (
          <Fragment key={item.id}>
            {sep && <div className="day-sep">{day}</div>}
            <ItemView item={item} onOpenFile={onOpenFile} avatar={avatar} />
          </Fragment>
        );
      })}
    </div>
  );
}

function ItemView({ item, onOpenFile, avatar }: { item: Item; onOpenFile: (id: string) => void; avatar: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg msg-user" id={`item-${item.id}`}>
          <div className="bubble">{item.text}</div>
          <div className="msg-time">{timeLabel(item.created_at)}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className={`msg msg-assistant ${item.streaming ? 'streaming' : ''}`} id={`item-${item.id}`}>
          {avatar ? <BrandBadge size={34} live={item.streaming} /> : <span className="avatar-gap" />}
          <div className="say">
            {item.task_id && <TaskLabel id={item.task_id} />}
            {item.text ? <Markdown text={item.text} /> : <TypingDots />}
          </div>
        </div>
      );
    case 'card':
      return <CardView item={item} onOpenFile={onOpenFile} />;
    case 'activity':
      return <Activity item={item} />;
    case 'system':
      return (
        <div className="msg-system" id={`item-${item.id}`}>
          {item.text}
        </div>
      );
  }
}

function TaskLabel({ id }: { id: string }) {
  const title = useStore((s) => s.tasks.find((t) => t.id === id)?.title);
  return <div className="msg-task">Task · {title ?? 'Background work'}</div>;
}

function TypingDots() {
  return (
    <span className="typing" aria-label="Thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

function Activity({ item }: { item: Item }) {
  const a = item.activity!;
  const [open, setOpen] = useState(false);
  const running = a.status === 'running';
  const n = a.steps.length;
  const current = [...a.steps].reverse().find((s) => s.status === 'running');
  const label = running
    ? current
      ? current.label || prettyTool(current.name)
      : 'Thinking'
    : a.status === 'error'
      ? `Stopped on an error${a.error ? `: ${a.error}` : ''}`
      : a.status === 'stopped'
        ? 'Stopped'
        : `Worked through ${n} step${n === 1 ? '' : 's'}`;
  if (!running && n === 0 && a.status === 'done') return null;
  return (
    <div className={`activity ${running ? 'running' : ''} ${a.status}`} id={`item-${item.id}`}>
      <button className="activity-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="activity-dot" aria-hidden="true" />
        <span className="activity-label">{label}</span>
        {n > 0 && <Icon.chevron size={14} className={`activity-chev ${open ? 'open' : ''}`} />}
      </button>
      {open && n > 0 && (
        <ol className="activity-steps">
          {a.steps.map((s) => (
            <li key={s.id} className={s.status}>
              <span className="step-name">{s.label || prettyTool(s.name)}</span>
              {s.ended_at && <span className="step-time">{Math.max(1, Math.round((s.ended_at - s.started_at) / 1000))}s</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function prettyTool(name: string) {
  const n = name.replace(/^mcp_+/, '').replace(/^duet_+/, '').replace(/[_-]+/g, ' ');
  return n.charAt(0).toUpperCase() + n.slice(1);
}
