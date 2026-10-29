import { useEffect, useRef, useState } from 'react';
import { askAge } from '../../../shared/age';
import type { CardData, FollowUp, Item, PaymentItem, WatchEntry } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Icon, Markdown, bytesLabel, fileIcon, timeLabel } from '../ui';

const KIND_LABEL: Record<CardData['type'], string> = {
  approval: 'Needs your OK',
  payment: 'Check before I spend',
  choice: 'Question',
  brief: 'Brief',
  checklist: 'Checklist',
  metrics: 'Dashboard',
  file: 'Ready for review',
  note: 'Note',
  handover: 'Finished',
};

export function CardView({ item, onOpenFile }: { item: Item; onOpenFile: (id: string) => void }) {
  const card = item.card!;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = card.status === 'pending';
  const [draft, setDraft] = useState(card.draft ?? '');
  const draftEdited = !!card.draft && draft.trim() !== card.draft.trim();
  const tz = useStore((s) => s.settings?.timezone);
  // An ask left waiting since yesterday may no longer hold ("tomorrow" in its draft, an errand already done).
  const age = pending && (card.type === 'approval' || card.type === 'choice') ? askAge(item.created_at, Date.now(), tz) : null;

  async function act(action: string, value?: string) {
    // Busy marks the tapped button; an approval's value is the edited draft, not a button label.
    setBusy(action === 'choose' ? (value ?? action) : action);
    setErr(null);
    try {
      await api.act(item.id, action, value);
    } catch (e: any) {
      setErr(e.message ?? 'Failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={`card card-${card.type} ${pending ? 'is-pending' : ''} ${card.failed ? 'is-failed' : ''}`} id={`item-${item.id}`}>
      <header className="card-head">
        <span className="card-kind">{card.failed ? 'Didn’t finish' : card.alert ? 'Heads up' : KIND_LABEL[card.type]}</span>
        <span className="card-meta">{card.updated_label ?? timeLabel(item.updated_at)}</span>
      </header>
      <h3 className="card-title">{card.title}</h3>
      {card.type === 'brief' && <ListenButton item={item} />}
      {card.body && <Markdown text={card.body} className="card-body" />}

      {card.type === 'brief' && card.entries?.length ? <BriefList id={item.id} card={card} onOpenFile={onOpenFile} /> : null}
      {card.type === 'brief' && card.watching?.length ? <Watching list={card.watching} onOpenFile={onOpenFile} /> : null}
      {card.type === 'checklist' && card.checklist && <Checklist card={card} />}
      {card.type === 'metrics' && card.metrics && (
        <div className="metrics">
          {card.metrics.map((m, i) => (
            <div className="metric" key={i}>
              <div className="metric-label">{m.label}</div>
              <div className="metric-value">{m.value}</div>
              {m.delta && <div className={`metric-delta tone-${m.tone ?? 'neutral'}`}>{m.delta}</div>}
            </div>
          ))}
        </div>
      )}
      {card.type === 'file' && card.file_id && <FileRow fileId={card.file_id} onOpen={onOpenFile} />}
      {card.type === 'payment' && <PaymentDetails card={card} />}
      {card.type === 'handover' && (
        <>
          {card.file_ids?.map((id) => <FileRow key={id} fileId={id} onOpen={onOpenFile} />)}
          {card.follow_ups?.length ? <FollowUps id={item.id} list={card.follow_ups} /> : null}
          {card.failed && card.retry && !card.decision && (
            <div className="follow-ups">
              <button className="chip" disabled={!!busy} onClick={() => act('retry')}>
                {busy === 'retry' ? 'Starting…' : 'Try again'}
              </button>
            </div>
          )}
          {card.failed && card.decision && <Decision card={card} />}
        </>
      )}

      {card.type === 'approval' && card.draft && (pending && !card.hermes ? (
        <DraftEditor original={card.draft} value={draft} onChange={setDraft} disabled={!!busy} />
      ) : (
        <div className="approval-draft is-readonly">{card.draft}</div>
      ))}
      {age && <p className="card-age">{card.type === 'choice' ? `Asked ${age}` : `Written ${age} · check it still fits`}</p>}
      {card.type === 'approval' &&
        (pending ? (
          <div className="card-actions">
            <button className="btn btn-primary" disabled={!!busy || (draftEdited && !draft.trim())} onClick={() => act('approve', draftEdited ? draft : undefined)}>
              {busy === 'approve' ? 'Approving…' : card.action_label || 'Approve'}
            </button>
            <button className="btn btn-ghost" disabled={!!busy} onClick={() => act('decline')}>
              Not now
            </button>
          </div>
        ) : (
          <Decision card={card} />
        ))}

      {card.type === 'payment' &&
        (pending ? (
          <div className="card-actions">
            <button className="btn btn-primary pay" disabled={!!busy} onClick={() => act('approve')}>
              {busy === 'approve' ? 'Approving…' : card.action_label || 'Approve & pay'}
            </button>
            <button className="btn btn-ghost" disabled={!!busy} onClick={() => act('decline')}>
              Decline
            </button>
          </div>
        ) : (
          <Decision card={card} />
        ))}

      {card.type === 'choice' &&
        (pending ? (
          <div className="card-actions wrap">
            {(card.options?.length ? card.options : ['Yes', 'No']).map((o, i) => (
              <button key={o} className={`btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}`} disabled={!!busy} onClick={() => act('choose', o)}>
                {busy === o ? '…' : o}
              </button>
            ))}
          </div>
        ) : (
          <Decision card={card} />
        ))}
      {err && <p className="card-error">{err}</p>}
    </article>
  );
}

/**
 * "Listen": the brief read aloud, so the morning can be taken in while walking. The audio is synthesized on the Mac
 * and cached; a lock-screen player is exposed through the Media Session API so playback survives switching apps.
 */
function ListenButton({ item }: { item: Item }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const title = item.card?.title ?? 'Morning brief';

  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
    },
    [],
  );

  function stop() {
    const el = audio.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setState('idle');
  }

  async function toggle() {
    setErr(null);
    const el = audio.current ?? new Audio();
    audio.current = el;
    if (state === 'playing') {
      el.pause();
      setState('idle');
      return;
    }
    try {
      if (el.src !== new URL(`/api/brief/${item.id}/audio`, location.href).href) {
        el.src = `/api/brief/${item.id}/audio`;
        el.preload = 'auto';
      }
      el.onended = () => setState('idle');
      el.onerror = () => {
        setState('idle');
        setErr('Could not play the brief. Set up speech on the Mac: hermes-duet doctor.');
      };
      const session = (navigator as any).mediaSession;
      if (session && typeof MediaMetadata !== 'undefined') {
        session.metadata = new MediaMetadata({ title, artist: 'Hermes Duet', album: 'Morning brief' });
        session.setActionHandler?.('play', () => void el.play());
        session.setActionHandler?.('pause', () => el.pause());
        session.setActionHandler?.('stop', stop);
      }
      setState('loading');
      await el.play();
      setState('playing');
    } catch (e: any) {
      setState('idle');
      setErr(/not allowed|gesture/i.test(String(e?.message)) ? 'Tap Listen again to allow audio.' : 'Could not play the brief.');
    }
  }

  return (
    <>
      <button className={`listen ${state}`} onClick={toggle} aria-label={state === 'playing' ? 'Pause the brief' : 'Listen to the brief'}>
        {state === 'playing' ? <Icon.stop size={14} /> : <Icon.play size={14} />}
        {state === 'playing' ? 'Pause' : state === 'loading' ? 'Getting audio…' : 'Listen'}
      </button>
      {err && <p className="card-error">{err}</p>}
    </>
  );
}

/** The receipt behind a payment card: every line, the total, and what the cap was. Never any card number. */
function PaymentDetails({ card }: { card: CardData }) {
  const items = card.line_items ?? [];
  const currency = card.currency ?? 'USD';
  const price = (cents: number) => {
    try {
      return new Intl.NumberFormat([], { style: 'currency', currency }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  };
  return (
    <div className="payment">
      {items.length > 0 && (
        <ul className="payment-items">
          {items.map((it: PaymentItem, i) => (
            <li key={i}>
              <span className="pay-title">
                {it.title}
                {(it.quantity ?? 1) > 1 && <span className="pay-qty"> × {it.quantity}</span>}
              </span>
              <span className="pay-price">{price(it.price_cents * (it.quantity ?? 1))}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="payment-total">
        <span>Total</span>
        <strong>{price(card.amount_cents ?? 0)}</strong>
      </div>
      {card.merchant && <div className="payment-merchant">To {card.merchant}</div>}
      {card.cap_cents ? (
        <div className="payment-cap">
          Capped at {price(card.cap_cents)} per payment{card.amount_cents !== undefined && card.amount_cents < card.cap_cents ? ` · ${price(card.cap_cents - card.amount_cents)} under the limit` : ''}
        </div>
      ) : null}
      {card.card_summary && <div className="payment-card-note">{card.card_summary}</div>}
    </div>
  );
}

/** What the user decided, in one line. */
function Decision({ card }: { card: CardData }) {
  const label =
    card.status === 'approved'
      ? (card.action_label && /^send/i.test(card.action_label) ? 'Sent' : 'Approved') + (card.edited ? ' with your edits' : '')
      : card.status === 'declined'
        ? 'Not now'
        : card.status === 'expired'
          ? `Expired${card.decision ? ` · ${card.decision}` : ''}`
          : card.decision ?? 'Answered';
  return (
    <div className={`decision decision-${card.status}`}>
      {card.status === 'approved' || card.status === 'answered' ? <Icon.check size={16} /> : null}
      <span>
        {card.status === 'answered' ? `You chose “${card.decision}”` : label}
        {card.decided_at ? ` · ${timeLabel(card.decided_at)}` : ''}
      </span>
    </div>
  );
}

/** The exact text an approval will send, editable until the user decides. Approving sends their version back. */
function DraftEditor({ original, value, onChange, disabled }: { original: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const edited = value.trim() !== original.trim();
  return (
    <div className="approval-draft">
      <div className="approval-draft-head">
        <span>{edited ? 'Edited draft' : 'Draft · tap to edit'}</span>
        {edited && (
          <button className="link" disabled={disabled} onClick={() => onChange(original)}>
            Undo edits
          </button>
        )}
      </div>
      <textarea
        aria-label="Draft to send"
        value={value}
        disabled={disabled}
        rows={Math.min(14, Math.max(3, value.split('\n').length + 1))}
        onChange={(e) => onChange(e.target.value)}
      />
      {edited && !value.trim() && <p className="card-error">The draft is empty.</p>}
    </div>
  );
}

/**
 * One-tap chips that act through the stored card: the server reads what to send from the card, not from here,
 * and marks the chip `used` on it, so "On it" survives a reload and shows on every device. `sent` only covers
 * the moment between the tap and the card coming back.
 */
function useChips(id: string, action: string) {
  const [sent, setSent] = useState<Record<number, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  async function tap(i: number, act = action) {
    setSent((s) => ({ ...s, [i]: true }));
    setErr(null);
    try {
      await api.act(id, act, String(i));
    } catch (e: any) {
      setSent((s) => ({ ...s, [i]: false }));
      setErr(e.message ?? 'Failed');
    }
  }
  return { sent, err, tap };
}

function BriefList({ id, card, onOpenFile }: { id: string; card: CardData; onOpenFile: (id: string) => void }) {
  // An entry with a draft hands that draft back to the agent, which then asks for approval with it instead of
  // redrafting; an entry without one sends its action_message as the user.
  const { sent, err, tap } = useChips(id, 'send_action');
  // "Skip" says the entry doesn't need the user; the server keeps the mark, so later check-ins and briefs drop it.
  const [skipping, setSkipping] = useState<number | null>(null);
  const [skipErr, setSkipErr] = useState<string | null>(null);
  async function skip(i: number, undo: boolean) {
    setSkipping(i);
    setSkipErr(null);
    try {
      await api.act(id, undo ? 'unskip' : 'skip', String(i));
    } catch (e: any) {
      setSkipErr(e.message ?? 'Failed');
    } finally {
      setSkipping(null);
    }
  }
  return (
    <>
      <ol className="brief">
        {card.entries!.map((e, i) => {
          const done = sent[i] || e.used;
          return (
            <li key={i} className={`brief-entry prio-${e.priority ?? 'medium'} ${e.skipped_at ? 'is-skipped' : ''}`}>
              <span className="prio-dot" aria-hidden="true" />
              <div className="brief-main">
                <div className="brief-title">{e.title}</div>
                {e.detail && <div className="brief-detail">{e.detail}</div>}
                {e.file_id && <PageLink fileId={e.file_id} onOpen={onOpenFile} />}
                {e.skipped_at ? (
                  <div className="brief-skipped">
                    Skipped · won’t come back unless it changes
                    <button className="link" disabled={skipping === i} onClick={() => skip(i, true)}>
                      Undo
                    </button>
                  </div>
                ) : (
                  <>
                    {e.draft && (
                      <details className="brief-draft">
                        <summary>Draft ready</summary>
                        <Markdown text={e.draft} className="brief-draft-body" />
                      </details>
                    )}
                    <div className="brief-actions">
                      {e.draft ? (
                        <button className="chip" disabled={done || skipping === i} onClick={() => tap(i, 'use_draft')}>
                          {done ? 'On it' : e.action_label || 'Send as drafted'}
                        </button>
                      ) : e.action_label && e.action_message && (
                        <button className="chip" disabled={done || skipping === i} onClick={() => tap(i)}>
                          {done ? 'On it' : e.action_label}
                        </button>
                      )}
                      {!done && (
                        <button className="link" disabled={skipping === i} onClick={() => skip(i, false)}>
                          Skip
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {(err || skipErr) && <p className="card-error">{err || skipErr}</p>}
    </>
  );
}

function Watching({ list, onOpenFile }: { list: WatchEntry[]; onOpenFile: (id: string) => void }) {
  return (
    <section className="watching" aria-label="Watching">
      <div className="watching-head">Watching</div>
      <ul>
        {list.map((w, i) => (
          <li key={i}>
            <span className="watching-title">{w.title}</span>
            {w.detail && <span className="watching-detail"> · {w.detail}</span>}
            {w.file_id && <PageLink fileId={w.file_id} onOpen={onOpenFile} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A brief line about a standing page opens the version the brief was written about. Nothing if the file is gone. */
function PageLink({ fileId, onOpen }: { fileId: string; onOpen: (id: string) => void }) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId));
  if (!file) return null;
  return (
    <button className="link page-link" onClick={() => onOpen(file.id)} aria-label={`Open ${file.title}`}>
      Open page
    </button>
  );
}

function FollowUps({ id, list }: { id: string; list: FollowUp[] }) {
  const { sent, err, tap } = useChips(id, 'follow_up');
  return (
    <>
      <div className="follow-ups">
        {list.map((f, i) => (
          <button key={i} className="chip" disabled={sent[i] || f.used} onClick={() => tap(i)}>
            {sent[i] || f.used ? 'On it' : f.label}
          </button>
        ))}
      </div>
      {err && <p className="card-error">{err}</p>}
    </>
  );
}

function Checklist({ card }: { card: CardData }) {
  const list = card.checklist!;
  const done = list.filter((c) => c.done).length;
  const [open, setOpen] = useState(list.length <= 8);
  const shown = open ? list : [...list.filter((c) => !c.done).slice(0, 5)];
  return (
    <div className="checklist">
      <div className="progress" role="progressbar" aria-valuenow={done} aria-valuemax={list.length}>
        <div className="progress-bar" style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} />
      </div>
      <div className="progress-label">
        {done} of {list.length} done
      </div>
      <ul>
        {shown.map((c, i) => (
          <li key={i} className={c.done ? 'done' : ''}>
            <span className="tick">{c.done ? <Icon.check size={13} /> : null}</span>
            {c.text}
          </li>
        ))}
      </ul>
      {!open && list.length > shown.length && (
        <button className="link" onClick={() => setOpen(true)}>
          Show all {list.length}
        </button>
      )}
    </div>
  );
}

export function FileRow({ fileId, onOpen }: { fileId: string; onOpen: (id: string) => void }) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId));
  if (!file) return <div className="file-row muted">File unavailable</div>;
  const FIcon = fileIcon(file.mime, file.name);
  return (
    <button className="file-row" onClick={() => onOpen(file.id)}>
      <span className="file-icon">
        <FIcon size={22} />
      </span>
      <span className="file-text">
        <span className="file-title">{file.title}</span>
        <span className="file-sub">
          {file.name} · {bytesLabel(file.size)}
        </span>
      </span>
      <Icon.chevron size={18} />
    </button>
  );
}
