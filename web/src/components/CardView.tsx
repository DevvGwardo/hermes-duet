import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { askAge } from '../../../shared/age';
import type { CardData, FollowUp, Item, PaymentItem, Source, WatchEntry } from '../../../shared/types';
import { api } from '../api';
import { isSafeSourceUrl } from '../sources';
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
  const [serverDraft, setServerDraft] = useState(card.draft ?? '');
  // The agent can redraft a card that is already on screen (`replaces`). Re-sync when the server's draft changes, so
  // Approve never sends text the agent has since replaced — `draftEdited` compared the new draft against a stale copy.
  if ((card.draft ?? '') !== serverDraft) {
    setServerDraft(card.draft ?? '');
    setDraft(card.draft ?? '');
  }
  const draftEdited = !!card.draft && draft.trim() !== card.draft.trim();
  const tz = useStore((s) => s.settings?.timezone);
  // An ask left waiting since yesterday may no longer hold ("tomorrow" in its draft, an errand already done).
  // Tick once a minute (and on visibility return) so an idle window keeps the age badge current.
  const tracksAge = pending && (card.type === 'approval' || card.type === 'choice');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tracksAge) return;
    setNow(Date.now());
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [tracksAge, item.created_at]);
  const age = tracksAge ? askAge(item.created_at, now, tz) : null;

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
      {card.sources?.length ? <SourceChips sources={card.sources} onOpenFile={onOpenFile} /> : null}

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
          {!card.failed &&
            (card.confirmed_at ? (
              <div className="decision decision-answered">
                <Icon.check size={16} />
                <span>Confirmed by you · {timeLabel(card.confirmed_at)}</span>
              </div>
            ) : (
              <div className="follow-ups">
                <button className="chip" disabled={!!busy} onClick={() => act('complete')}>
                  {busy === 'complete' ? 'Marking…' : 'Mark done'}
                </button>
              </div>
            ))}
        </>
      )}

      {card.type === 'approval' && <ApprovalMeta card={card} />}
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
      {(err || card.error) && <p className="card-error" role="alert">{err ?? card.error}</p>}
    </article>
  );
}

interface ActiveBriefAudio {
  owner: symbol;
  pause: () => void;
}

let activeBriefAudio: ActiveBriefAudio | null = null;

function clearMediaSession(owner: symbol) {
  if (activeBriefAudio?.owner === owner) {
    activeBriefAudio = null;
  }
  const session = (navigator as any).mediaSession;
  if (!session) return;
  if (activeBriefAudio && activeBriefAudio.owner !== owner) return;
  try {
    session.setActionHandler?.('play', null);
    session.setActionHandler?.('pause', null);
    session.setActionHandler?.('stop', null);
    session.metadata = null;
  } catch {}
}

/**
 * "Listen": the brief read aloud, so the morning can be taken in while walking. The audio is synthesized on the host
 * and cached; a lock-screen player is exposed through the Media Session API so playback survives switching apps.
 */
function ListenButton({ item }: { item: Item }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const loadingRef = useRef(false);
  const needsReloadRef = useRef(true);
  const mountedRef = useRef(true);
  const owner = useRef(Symbol('listen'));
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const title = item.card?.title ?? 'Morning brief';

  useEffect(() => {
    needsReloadRef.current = true;
  }, [item.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadingRef.current = false;
      const el = audio.current;
      if (el) {
        el.onplaying = null;
        el.onplay = null;
        el.onpause = null;
        el.onended = null;
        el.onerror = null;
        el.pause();
        el.removeAttribute('src');
        el.load();
        audio.current = null;
      }
      clearMediaSession(owner.current);
    };
  }, []);

  function pauseFromController() {
    loadingRef.current = false;
    const el = audio.current;
    if (el && !el.paused) {
      el.pause();
    }
    if (mountedRef.current) setState('idle');
  }

  function stop() {
    loadingRef.current = false;
    const el = audio.current;
    if (el) {
      el.pause();
      try {
        el.currentTime = 0;
      } catch {}
    }
    clearMediaSession(owner.current);
    if (mountedRef.current) setState('idle');
  }

  async function toggle() {
    if (loadingRef.current || state === 'loading') return;
    setErr(null);

    // Prepare / reuse the HTMLAudioElement synchronously inside the tap gesture so iOS Safari stays unlocked.
    const el = audio.current ?? new Audio();
    audio.current = el;
    (el as any).playsInline = true;

    if (state === 'playing' && !el.paused) {
      el.pause();
      clearMediaSession(owner.current);
      setState('idle');
      return;
    }

    // Pause any other brief currently playing before claiming Media Session.
    if (activeBriefAudio && activeBriefAudio.owner !== owner.current) {
      activeBriefAudio.pause();
    }
    activeBriefAudio = { owner: owner.current, pause: pauseFromController };

    loadingRef.current = true;
    setState('loading');

    const audioPath = `/api/brief/${encodeURIComponent(item.id)}/audio`;
    const targetUrl = new URL(audioPath, location.href).href;
    let mediaErrorMsg: string | null = null;

    el.onplaying = () => {
      if (mountedRef.current && activeBriefAudio?.owner === owner.current) setState('playing');
    };
    el.onplay = () => {
      if (mountedRef.current && activeBriefAudio?.owner === owner.current) setState('playing');
    };
    el.onpause = () => {
      if (!loadingRef.current && mountedRef.current) setState('idle');
    };
    el.onended = () => {
      clearMediaSession(owner.current);
      if (mountedRef.current) setState('idle');
    };
    el.onerror = () => {
      loadingRef.current = false;
      needsReloadRef.current = true;
      mediaErrorMsg = 'Could not play the brief. Set up speech on the host: hermes-duet doctor.';
      clearMediaSession(owner.current);
      if (mountedRef.current) {
        setState('idle');
        setErr(mediaErrorMsg);
      }
    };

    try {
      if (el.src !== targetUrl || needsReloadRef.current || el.error) {
        el.src = audioPath;
        el.preload = 'auto';
        el.load();
        needsReloadRef.current = false;
      }

      const session = (navigator as any).mediaSession;
      if (session && typeof MediaMetadata !== 'undefined') {
        session.metadata = new MediaMetadata({ title, artist: 'Hermes Duet', album: 'Morning brief' });
        session.setActionHandler?.('play', () => void el.play());
        session.setActionHandler?.('pause', () => el.pause());
        session.setActionHandler?.('stop', stop);
      }

      // Invoke play() synchronously in the tap gesture before awaiting.
      const playPromise = el.play();
      await playPromise;
      if (mountedRef.current && activeBriefAudio?.owner === owner.current) {
        setState('playing');
      }
    } catch (e: any) {
      if (!mountedRef.current) return;
      const superseded = activeBriefAudio?.owner !== owner.current;
      if (superseded && e?.name === 'AbortError') {
        setState('idle');
        return;
      }
      needsReloadRef.current = true;
      clearMediaSession(owner.current);
      setState('idle');
      setErr(
        mediaErrorMsg || el.error
          ? mediaErrorMsg ?? 'Could not play the brief. Set up speech on the host: hermes-duet doctor.'
          : /not allowed|gesture/i.test(String(e?.message ?? e?.name))
            ? 'Tap Listen again to allow audio.'
            : 'Could not play the brief.',
      );
    } finally {
      loadingRef.current = false;
    }
  }

  return (
    <>
      <button
        type="button"
        className={`listen ${state}`}
        disabled={state === 'loading'}
        onClick={() => void toggle()}
        aria-pressed={state === 'playing'}
        aria-label={state === 'playing' ? 'Pause the brief' : 'Listen to the brief'}
      >
        {state === 'playing' ? <Icon.stop size={14} /> : <Icon.play size={14} />}
        {state === 'playing' ? 'Pause' : state === 'loading' ? 'Getting audio…' : 'Listen'}
      </button>
      {err && <p className="card-error" role="alert">{err}</p>}
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
      {card.merchant_host && (
        <div className="payment-merchant">
          Site: {card.merchant_url ? <a href={card.merchant_url} target="_blank" rel="noopener noreferrer">{card.merchant_host}</a> : card.merchant_host}
        </div>
      )}
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

/** The structured scope of an approval: what kind of action, who gets it, where it happens. Read-only. */
function ApprovalMeta({ card }: { card: CardData }) {
  const actionLabel: Record<string, string> = {
    send_email: 'Send email',
    send_message: 'Send message',
    post: 'Post',
    delete: 'Delete',
    sign: 'Sign',
    pay: 'Pay',
    other: 'Other',
  };
  const show = card.action || card.destination || (card.recipients?.length ?? 0) > 0 || card.url;
  if (!show && !card.scan_warning) return null;
  return (
    <>
      {show ? (
        <dl className="approval-meta">
          {card.action && (
            <div className="approval-meta-row">
              <dt>Action</dt>
              <dd>{actionLabel[card.action] ?? card.action}</dd>
            </div>
          )}
          {!!card.recipients?.length && (
            <div className="approval-meta-row">
              <dt>To</dt>
              <dd>
                {card.recipients.map((r) => (
                  <span key={r} className="recipient-chip">
                    {r}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {(card.destination || card.url) && (
            <div className="approval-meta-row">
              <dt>On</dt>
              <dd>
                {card.url ? (
                  <a href={card.url} target="_blank" rel="noopener">
                    {card.destination ?? card.url}
                  </a>
                ) : (
                  card.destination
                )}
              </dd>
            </div>
          )}
        </dl>
      ) : null}
      {card.scan_warning && (
        <p className="card-error" role="alert">
          {card.scan_warning}
        </p>
      )}
    </>
  );
}

/** The exact text an approval will send, editable until the user decides. Approving sends their version back. */
function DraftEditor({ original, value, onChange, disabled }: { original: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const edited = value.trim() !== original.trim();
  const ta = useRef<HTMLTextAreaElement | null>(null);
  // A long draft should read whole, not through a 3-line keyhole: grow with the
  // content like the composer does, capped so the card actions stay in view.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);
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
        ref={ta}
        aria-label="Draft to send"
        value={value}
        disabled={disabled}
        rows={3}
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
                {e.sources?.length ? <SourceChips sources={e.sources} onOpenFile={onOpenFile} /> : null}
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
      {(err || skipErr) && <p className="card-error" role="alert">{err || skipErr}</p>}
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
            {w.sources?.length ? <SourceChips sources={w.sources} onOpenFile={onOpenFile} /> : null}
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

/**
 * Provenance chips for an entry, a watching line or a whole card. file/page
 * chips open through the existing file viewer (a page resolves to the version
 * the brief was written about); url chips are plain external links; anything
 * else is a readable label. Any chip with a `quote` exposes an inline excerpt
 * on tap/click or keyboard focus so phones don't rely on hover tooltips.
 */
export function SourceChips({ sources, onOpenFile }: { sources: Source[]; onOpenFile: (id: string) => void }) {
  const pages = useStore((s) => s.pages);
  const [openQuote, setOpenQuote] = useState<number | null>(null);
  const pointerDownRef = useRef(false);

  if (!sources.length) return null;

  const markPointer = () => {
    pointerDownRef.current = true;
    requestAnimationFrame(() => {
      pointerDownRef.current = false;
    });
  };
  const toggleQuote = (i: number) => setOpenQuote((cur) => (cur === i ? null : i));
  const focusQuote = (i: number) => {
    if (!pointerDownRef.current) setOpenQuote(i);
  };
  const quoteBtn = (i: number, label: string) => (
    <button
      type="button"
      className={`chip source source-quote-btn ${openQuote === i ? 'on' : ''}`}
      aria-expanded={openQuote === i}
      aria-label={`View quote for ${label}`}
      onPointerDown={markPointer}
      onFocus={() => focusQuote(i)}
      onClick={() => toggleQuote(i)}
    >
      “”
    </button>
  );

  const activeQuote = openQuote !== null ? sources[openQuote] : null;

  return (
    <div className="sources-wrap">
      <div className="sources" aria-label="Sources">
        {sources.map((s, i) => {
          const hint = s.quote ?? s.label;
          if (s.kind === 'file' && s.id) {
            const btn = (
              <button type="button" className="chip source" title={hint} onClick={() => onOpenFile(s.id!)} aria-label={`Open source ${s.label}`}>
                {s.label}
              </button>
            );
            return s.quote ? (
              <span key={i} className="source-pair">
                {btn}
                {quoteBtn(i, s.label)}
              </span>
            ) : (
              <span key={i}>{btn}</span>
            );
          }
          if (s.kind === 'page' && s.id) {
            const fileId = pages.find((p) => p.id === s.id)?.file_id;
            if (fileId) {
              const btn = (
                <button type="button" className="chip source" title={hint} onClick={() => onOpenFile(fileId)} aria-label={`Open source ${s.label}`}>
                  {s.label}
                </button>
              );
              return s.quote ? (
                <span key={i} className="source-pair">
                  {btn}
                  {quoteBtn(i, s.label)}
                </span>
              ) : (
                <span key={i}>{btn}</span>
              );
            }
          }
          if (s.kind === 'url' && isSafeSourceUrl(s.url)) {
            const link = (
              <a className="chip source" href={s.url} target="_blank" rel="noreferrer noopener" title={hint}>
                {s.label}
              </a>
            );
            return s.quote ? (
              <span key={i} className="source-pair">
                {link}
                {quoteBtn(i, s.label)}
              </span>
            ) : (
              <span key={i}>{link}</span>
            );
          }
          if (s.quote) {
            return (
              <button
                key={i}
                type="button"
                className={`chip source is-label has-quote ${openQuote === i ? 'on' : ''}`}
                title={hint}
                aria-expanded={openQuote === i}
                onPointerDown={markPointer}
                onFocus={() => focusQuote(i)}
                onClick={() => toggleQuote(i)}
              >
                {s.label}
              </button>
            );
          }
          return (
            <span key={i} className="chip source is-label" title={hint}>
              {s.label}
            </span>
          );
        })}
      </div>
      {activeQuote?.quote && (
        <blockquote className="source-quote" aria-label={`Quote from ${activeQuote.label}`}>
          <span className="source-quote-label">{activeQuote.label}:</span> “{activeQuote.quote}”
        </blockquote>
      )}
    </div>
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
      {err && <p className="card-error" role="alert">{err}</p>}
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
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuenow={done} aria-valuemax={list.length} aria-valuetext={`${done} of ${list.length} done`} aria-label="Checklist progress">
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
