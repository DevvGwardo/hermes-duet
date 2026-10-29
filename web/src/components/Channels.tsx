import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '../../../shared/types';
import { openChannel, api } from '../api';
import { setChannel, useStore } from '../store';
import { Icon } from '../ui';

/**
 * The channel strip above the thread: one pill per topic thread, "#" for the rest. The general channel stays first
 * because it is where briefs and background results land; everything else is a project of its own.
 */
export function ChannelsStrip({ onSearch, onManage }: { onSearch: () => void; onManage: () => void }) {
  const channels = useStore((s) => s.channels);
  const active = useStore((s) => s.channelId);
  return (
    <nav className="channels" aria-label="Channels">
      <div className="channels-scroll">
        {channels.map((c) => (
          <button
            key={c.id}
            className={`channel-pill ${active === c.id ? 'on' : ''}`}
            onClick={() => openChannel(c.id).catch(() => {})}
            aria-current={active === c.id}
            title={c.topic ?? c.name}
          >
            <Icon.hash size={13} />
            {c.slug}
          </button>
        ))}
        <button className="channel-pill add" onClick={onManage} aria-label="New channel or manage channels">
          <Icon.plus size={15} />
        </button>
      </div>
      <button className="icon-btn channel-search" onClick={onSearch} aria-label="Search everything">
        <Icon.search size={18} />
      </button>
    </nav>
  );
}

/** Create a channel, or archive one that has served its purpose. Its history stays searchable either way. */
export function ChannelsSheet({ onClose }: { onClose: () => void }) {
  const channels = useStore((s) => s.channels);
  const active = useStore((s) => s.channelId);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { channel } = await api.createChannel(name.trim(), topic.trim() || undefined);
      setName('');
      setTopic('');
      await openChannel(channel.id);
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not create that channel.');
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.archiveChannel(id);
      if (active === id) {
        const next = channels.find((c) => c.id !== id);
        if (next) setChannel(next.id);
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Could not archive that channel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet channels-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>Channels</strong>
            <span className="muted">Separate threads, one memory</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="settings-body">
          <section>
            <h3>Open</h3>
            <ul className="list">
              {channels.map((c) => (
                <li key={c.id} className={`channel-row ${c.id === active ? 'on' : ''}`}>
                  <button className="channel-row-main" onClick={() => openChannel(c.id).then(onClose).catch(() => {})}>
                    <span className="channel-hash">
                      <Icon.hash size={14} />
                    </span>
                    <span className="row-main">
                      <span className="row-title">{c.slug}</span>
                      <span className="row-sub">{c.topic || (c.id === channels[0]?.id ? 'Briefs, check-ins, background results' : 'No topic yet')}</span>
                    </span>
                    {c.id === active && <Icon.check size={16} />}
                  </button>
                  {c.id !== channels[0]?.id && (
                    <button className="icon-btn" disabled={busy} onClick={() => archive(c.id)} aria-label={`Archive ${c.slug}`} title="Archive channel">
                      <Icon.archive size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>New channel</h3>
            <form className="channel-form" onSubmit={create}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="taxes" aria-label="Channel name" maxLength={40} autoCapitalize="off" />
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What it is for (optional)" aria-label="Channel topic" maxLength={200} />
              <button className="btn btn-primary small" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </form>
            {err && <p className="card-error">{err}</p>}
            <p className="muted small">Each channel gets its own Hermes session, so long projects don't fill the main thread. Memory and files are shared.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<SearchHit['kind'], string> = { item: 'Thread', task: 'Task', file: 'File', page: 'Page' };

/**
 * Search across every channel, task, delivered file and standing page. Results are a plain list of excerpts with the
 * matched words marked; tapping one opens the thing itself.
 */
export function SearchOverlay({
  onClose,
  onJump,
  onShowTasks,
  onOpenFile,
}: {
  onClose: () => void;
  onJump: (id: string) => void;
  onShowTasks: () => void;
  onOpenFile: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Keyboard cursor over the hits: arrows move it, Enter opens it, hovering syncs it.
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const pages = useStore((s) => s.pages);
  const items = useStore((s) => s.items);
  const findChannel = (id: string) => items.find((i) => i.id === id)?.channel_id;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setHits([]);
      setTerms([]);
      setErr(null);
      return;
    }
    // Answers can arrive out of order while typing; only the newest query may write results.
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      api
        .search(text)
        .then((r) => {
          if (mine !== seq.current) return;
          setHits(r.hits);
          setTerms(r.terms);
          setActive(0);
          setErr(null);
        })
        .catch((e) => mine === seq.current && setErr(e?.message ?? 'Search failed'))
        .finally(() => mine === seq.current && setBusy(false));
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  function open(hit: SearchHit) {
    if (hit.kind === 'item') {
      const channel = hit.channel_id ?? findChannel(hit.id);
      if (channel) openChannel(channel).catch(() => {});
      onJump(hit.id);
      onClose();
    } else if (hit.kind === 'task') {
      onShowTasks();
      onClose();
    } else if (hit.kind === 'page') {
      const file = pages.find((p) => p.id === hit.id)?.file_id;
      if (file) onOpenFile(file);
      onClose();
    } else {
      onOpenFile(hit.id);
      onClose();
    }
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      setActive((a) => {
        const next = e.key === 'ArrowDown' ? Math.min(a + 1, hits.length - 1) : Math.max(a - 1, 0);
        requestAnimationFrame(() => {
          document.querySelectorAll('.search-hit')[next]?.scrollIntoView({ block: 'nearest' });
        });
        return next;
      });
    } else if (e.key === 'Enter') {
      const hit = hits[active];
      if (hit) {
        e.preventDefault();
        open(hit);
      }
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet search-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="sheet-head search-head">
          <Icon.search size={18} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search chats, tasks, files…"
            aria-label="Search everything"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="search-body">
          {err && <p className="card-error pad">{err}</p>}
          {!err && q.trim().length < 2 && <p className="muted pad">Type at least two letters. Everything you and I wrote, built or saved is indexed.</p>}
          {!err && q.trim().length >= 2 && !busy && hits.length === 0 && <p className="muted pad">Nothing matches that.</p>}
          <ul className="search-hits">
            {hits.map((hit, i) => (
              <li key={`${hit.kind}-${hit.id}`}>
                <button
                  className={`search-hit ${i === active ? 'active' : ''}`}
                  onClick={() => open(hit)}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="search-hit-kind">{KIND_LABEL[hit.kind]}</span>
                  <span className="search-hit-title">{highlight(hit.title, terms)}</span>
                  {/* A title-only match quotes the title back as the snippet; the title is the hit. */}
                  {hit.snippet.trim().toLowerCase() !== hit.title.trim().toLowerCase() && (
                    <span className="search-hit-snippet">{highlight(hit.snippet, terms)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {hits.length > 0 && (
            <div className="search-foot" aria-hidden="true">
              <span>
                <b>↑↓</b> move
              </span>
              <span>
                <b>↵</b> open
              </span>
              <span>
                <b>esc</b> close
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mark the matched words in a plain-text excerpt. Built from nodes, so nothing from the index becomes markup. */
function highlight(text: string, terms: string[]) {
  if (!terms.length) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  const set = new Set(terms.map((t) => t.toLowerCase()));
  return parts.map((part, i) =>
    set.has(part.toLowerCase()) ? (
      <mark key={i} className="hl">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** The topic line under the header when the user is in a channel other than general. */
export function ChannelBar() {
  const channel = useStore((s) => s.channels.find((c) => c.id === s.channelId));
  const general = useStore((s) => s.channels[0]);
  const topic = useMemo(() => channel?.topic ?? '', [channel]);
  if (!channel || channel.id === general?.id) return null;
  return (
    <div className="channel-bar">
      <span className="channel-bar-name">
        <Icon.hash size={13} />
        {channel.slug}
      </span>
      {topic && <span className="channel-bar-topic">{topic}</span>}
    </div>
  );
}