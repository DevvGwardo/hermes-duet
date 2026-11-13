import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, SearchHit } from '../../../shared/types';
import { openChannel, api } from '../api';
import { useStore } from '../store';
import { useDialogTrap } from '../hooks/useDialogTrap';
import { Icon } from '../ui';

/** True when the channel has activity the user has not opened yet. The open channel never shows one. */
function isUnread(c: Channel, active: string | null): boolean {
  return c.id !== active && (c.last_at ?? 0) > (c.seen_at ?? 0);
}

/**
 * The channel strip above the thread: one pill per topic thread, "#" for the rest. The general channel stays first
 * because it is where briefs and background results land; everything else is a project of its own.
 */
export function ChannelsStrip({ onSearch, onManage }: { onSearch: () => void; onManage: () => void }) {
  const channels = useStore((s) => s.channels);
  const active = useStore((s) => s.channelId);
  const [err, setErr] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    setErr(null);
  }, [active]);

  async function select(id: string) {
    setErr(null);
    try {
      await openChannel(id);
    } catch (e: any) {
      setErr({ id, message: e?.message ?? 'Could not open that channel.' });
    }
  }

  return (
    <>
      <nav className="channels" aria-label="Channels">
        <div className="channels-scroll">
          {channels.map((c) => (
            <button
              key={c.id}
              className={`channel-pill ${active === c.id ? 'on' : ''}`}
              onClick={() => void select(c.id)}
              aria-current={active === c.id}
              title={c.topic ?? c.name}
            >
              <Icon.hash size={13} />
              {c.slug}
              {isUnread(c, active) && <span className="unread-dot" aria-label="Unread" />}
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
      {err && (
        <div className="channel-strip-error" role="alert">
          <span>{err.message}</span>
          <button className="link" onClick={() => void select(err.id)}>
            Retry
          </button>
          <button className="icon-btn" onClick={() => setErr(null)} aria-label="Dismiss error">
            <Icon.close size={14} />
          </button>
        </div>
      )}
    </>
  );
}

const CHANNEL_TOOL_OPTIONS: { name: string; label: string }[] = [
  { name: 'request_approval', label: 'Approvals' },
  { name: 'request_payment', label: 'Payments' },
  { name: 'ask', label: 'Quick questions' },
  { name: 'post_brief', label: 'Briefs' },
  { name: 'post_card', label: 'Cards & checklists' },
  { name: 'deliver_file', label: 'Deliver files' },
  { name: 'save_page', label: 'Standing pages' },
  { name: 'save_routine', label: 'Routines' },
  { name: 'start_task', label: 'Background tasks' },
  { name: 'notify', label: 'Phone push' },
  { name: 'track_followup', label: 'Follow-ups' },
  { name: 'assign_channel', label: 'Route to channel' },
];

/** Create a channel, archive one that has served its purpose, or edit a channel's topic, group and standing instructions. */
export function ChannelsSheet({ onClose }: { onClose: () => void }) {
  const channels = useStore((s) => s.channels);
  const active = useStore((s) => s.channelId);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [group, setGroup] = useState('');
  const [repo, setRepo] = useState('');
  const [instructions, setInstructions] = useState('');
  const [allowedTools, setAllowedTools] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [eTopic, setETopic] = useState('');
  const [eGroup, setEGroup] = useState('');
  const [eRepo, setERepo] = useState('');
  const [eInstructions, setEInstructions] = useState('');
  const [eAllowedTools, setEAllowedTools] = useState<string[] | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog, onClose);

  // Group headings only when at least one channel is grouped; the general channel stays pinned first.
  const sections = useMemo(() => {
    const rest = channels.slice(1);
    if (!rest.some((c) => c.group)) return null;
    const byGroup = new Map<string, Channel[]>();
    const ungrouped: Channel[] = [];
    for (const c of rest) {
      if (c.group) {
        const list = byGroup.get(c.group) ?? [];
        list.push(c);
        byGroup.set(c.group, list);
      } else ungrouped.push(c);
    }
    return { names: [...byGroup.keys()].sort((a, b) => a.localeCompare(b)), byGroup, ungrouped };
  }, [channels]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { channel } = await api.createChannel(name.trim(), topic.trim() || undefined, {
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(group.trim() ? { group: group.trim() } : {}),
        ...(repo.trim() ? { repo: repo.trim() } : {}),
        ...(allowedTools && allowedTools.length ? { allowed_tools: allowedTools } : {}),
      });
      setName('');
      setTopic('');
      setGroup('');
      setRepo('');
      setInstructions('');
      setAllowedTools(null);
      await openChannel(channel.id);
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not create that channel.');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(c: Channel) {
    setEditing(c.id);
    setETopic(c.topic ?? '');
    setEGroup(c.group ?? '');
    setERepo(c.repo ?? '');
    setEInstructions(c.instructions ?? '');
    setEAllowedTools(c.allowed_tools ?? null);
    setErr(null);
  }

  async function saveEdit(id: string) {
    setBusy(true);
    setErr(null);
    try {
      // Empty strings clear the field server-side; absent keys would leave it alone.
      await api.updateChannel(id, {
        topic: eTopic.trim(),
        instructions: eInstructions.trim(),
        group: eGroup.trim(),
        repo: eRepo.trim(),
        allowed_tools: eAllowedTools && eAllowedTools.length ? eAllowedTools : null,
      });
      setEditing(null);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save that channel.');
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await openChannel(id);
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not open that channel.');
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.archiveChannel(id);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not archive that channel.');
      setBusy(false);
      return;
    }
    if (active === id) {
      const next = channels.find((c) => c.slug === 'general' && c.id !== id) ?? channels.find((c) => c.id !== id);
      if (next) {
        try {
          await openChannel(next.id);
        } catch (e: any) {
          setErr(e?.message ?? 'Channel archived, but could not load the next channel.');
        }
      }
    }
    setBusy(false);
  }

  function row(c: Channel, isGeneral: boolean) {
    return (
      <li key={c.id} className={`channel-row ${c.id === active ? 'on' : ''}`}>
        <div className="channel-row-wrap">
          <button className="channel-row-main" disabled={busy} onClick={() => void switchTo(c.id)}>
            <span className="channel-hash">
              <Icon.hash size={14} />
            </span>
            <span className="row-main">
              <span className="row-title">
                {c.slug}
                {isUnread(c, active) && <span className="unread-dot" aria-label="Unread" />}
              </span>
              <span className="row-sub">{c.topic || (isGeneral ? 'Briefs, check-ins, background results' : 'No topic yet')}</span>
            </span>
            {c.id === active && <Icon.check size={16} />}
          </button>
          <span className="channel-row-actions">
            {c.repo && (
              <a
                className="channel-repo"
                href={c.repo}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${c.repo} in a new tab`}
                aria-label={`Open ${c.repo}`}
              >
                <Icon.globe size={14} />
                <span className="channel-repo-text">{c.repo.replace(/^https?:\/\//, '')}</span>
              </a>
            )}
            <button className="icon-btn" disabled={busy} onClick={() => (editing === c.id ? setEditing(null) : startEdit(c))} aria-label={`Edit ${c.slug}`} title="Edit channel">
              <Icon.pencil size={16} />
            </button>
            {!isGeneral && (
              <button className="icon-btn" disabled={busy} onClick={() => archive(c.id)} aria-label={`Archive ${c.slug}`} title="Archive channel">
                <Icon.archive size={16} />
              </button>
            )}
          </span>
        </div>
        {editing === c.id && (
          <form
            className="channel-form channel-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit(c.id);
            }}
          >
            <ChannelFields
              topic={eTopic}
              onTopic={setETopic}
              group={eGroup}
              onGroup={setEGroup}
              repo={eRepo}
              onRepo={setERepo}
              instructions={eInstructions}
              onInstructions={setEInstructions}
              allowedTools={eAllowedTools}
              onAllowedTools={setEAllowedTools}
              instructionsPlaceholder="Standing instructions for this channel (optional)"
            />
            <span className="channel-edit-btns">
              <button className="btn btn-primary small" disabled={busy} type="submit">
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn small" disabled={busy} type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </span>
          </form>
        )}
      </li>
    );
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={dialog} className="sheet channels-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Channels">
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>Channels</strong>
            <span className="muted">Separate threads, one memory</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        {err && (
          <p className="sheet-error" role="alert">
            {err}
          </p>
        )}
        <div className="settings-body">
          <section>
            <h3>Open</h3>
            {sections ? (
              <>
                <ul className="list">{channels.length > 0 && row(channels[0], true)}</ul>
                {sections.names.map((g) => (
                  <div key={g}>
                    <h4 className="channel-group-head">{g}</h4>
                    <ul className="list">{sections.byGroup.get(g)!.map((c) => row(c, false))}</ul>
                  </div>
                ))}
                {sections.ungrouped.length > 0 && <ul className="list">{sections.ungrouped.map((c) => row(c, false))}</ul>}
              </>
            ) : (
              <ul className="list">{channels.map((c, i) => row(c, i === 0))}</ul>
            )}
          </section>
          <section>
            <h3>New channel</h3>
            <form className="channel-form" onSubmit={create}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="taxes" aria-label="Channel name" maxLength={40} autoCapitalize="off" />
              <ChannelFields
                topic={topic}
                onTopic={setTopic}
                group={group}
                onGroup={setGroup}
                repo={repo}
                onRepo={setRepo}
                instructions={instructions}
                onInstructions={setInstructions}
                allowedTools={allowedTools}
                onAllowedTools={setAllowedTools}
                instructionsPlaceholder="Standing instructions (optional)"
              />
              <button className="btn btn-primary small" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </form>
            {err && (
              <p className="card-error" role="alert">
                {err}
              </p>
            )}
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
  onJump: (id: string, channelId?: string | null) => void;
  onShowTasks: (taskId?: string | null) => void;
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
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog, onClose);
  const pages = useStore((s) => s.pages);
  const items = useStore((s) => s.items);
  const findChannel = (id: string) => items.find((i) => i.id === id)?.channel_id;

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
      onJump(hit.id, channel);
      onClose();
    } else if (hit.kind === 'task') {
      onShowTasks(hit.id);
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
      <div ref={dialog} className="sheet search-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Search">
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

function ChannelFields({
  topic,
  onTopic,
  group,
  onGroup,
  repo,
  onRepo,
  instructions,
  onInstructions,
  allowedTools,
  onAllowedTools,
  instructionsPlaceholder,
}: {
  topic: string;
  onTopic: (v: string) => void;
  group: string;
  onGroup: (v: string) => void;
  repo: string;
  onRepo: (v: string) => void;
  instructions: string;
  onInstructions: (v: string) => void;
  allowedTools: string[] | null;
  onAllowedTools: (v: string[] | null) => void;
  instructionsPlaceholder: string;
}) {
  const restricted = allowedTools !== null;
  function toggleTool(name: string) {
    const cur = allowedTools ?? CHANNEL_TOOL_OPTIONS.map((t) => t.name);
    const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    onAllowedTools(next.length ? next : []);
  }
  return (
    <>
      <input value={topic} onChange={(e) => onTopic(e.target.value)} placeholder="What it is for (optional)" aria-label="Channel topic" maxLength={200} />
      <input value={group} onChange={(e) => onGroup(e.target.value)} placeholder="Group (optional)" aria-label="Channel group" maxLength={40} />
      <input
        value={repo}
        onChange={(e) => onRepo(e.target.value)}
        placeholder="Repo (owner/name or GitHub URL, optional)"
        aria-label="Channel repo"
        maxLength={200}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <textarea
        value={instructions}
        onChange={(e) => onInstructions(e.target.value)}
        placeholder={instructionsPlaceholder}
        aria-label="Channel instructions"
        maxLength={2000}
        rows={3}
      />
      <div className="channel-tools-scope">
        <label className="channel-tools-toggle">
          <input
            type="checkbox"
            checked={!restricted}
            onChange={(e) => onAllowedTools(e.target.checked ? null : ['post_card', 'deliver_file', 'ask', 'request_approval'])}
          />
          <span>{restricted ? 'Restricted Duet tools' : 'All Duet tools allowed'}</span>
        </label>
        {restricted && (
          <div className="channel-tools-grid">
            {CHANNEL_TOOL_OPTIONS.map((t) => (
              <label key={t.name} className="channel-tool-check">
                <input type="checkbox" checked={allowedTools.includes(t.name)} onChange={() => toggleTool(t.name)} />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </>
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