import { useState } from 'react';
import type { CardData, FollowUp, Item } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Icon, Markdown, bytesLabel, fileIcon, timeLabel } from '../ui';

const KIND_LABEL: Record<CardData['type'], string> = {
  approval: 'Needs your OK',
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

  async function act(action: string, value?: string) {
    setBusy(value ?? action);
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
    <article className={`card card-${card.type} ${pending ? 'is-pending' : ''}`} id={`item-${item.id}`}>
      <header className="card-head">
        <span className="card-kind">{KIND_LABEL[card.type]}</span>
        <span className="card-meta">{card.updated_label ?? timeLabel(item.updated_at)}</span>
      </header>
      <h3 className="card-title">{card.title}</h3>
      {card.body && <Markdown text={card.body} className="card-body" />}

      {card.type === 'brief' && card.entries && <BriefList card={card} />}
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
      {card.type === 'handover' && (
        <>
          {card.file_ids?.map((id) => <FileRow key={id} fileId={id} onOpen={onOpenFile} />)}
          {card.follow_ups?.length ? <FollowUps list={card.follow_ups} /> : null}
        </>
      )}

      {card.type === 'approval' &&
        (pending ? (
          <div className="card-actions">
            <button className="btn btn-primary" disabled={!!busy} onClick={() => act('approve')}>
              {busy === 'approve' ? 'Approving…' : card.action_label || 'Approve'}
            </button>
            <button className="btn btn-ghost" disabled={!!busy} onClick={() => act('decline')}>
              Not now
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

function Decision({ card }: { card: CardData }) {
  const label =
    card.status === 'approved'
      ? card.action_label && /^send/i.test(card.action_label)
        ? 'Sent'
        : 'Approved'
      : card.status === 'declined'
        ? 'Not now'
        : card.status === 'expired'
          ? 'Expired'
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

function BriefList({ card }: { card: CardData }) {
  const [sent, setSent] = useState<Record<number, boolean>>({});
  return (
    <ol className="brief">
      {card.entries!.map((e, i) => (
        <li key={i} className={`brief-entry prio-${e.priority ?? 'medium'}`}>
          <span className="prio-dot" aria-hidden="true" />
          <div className="brief-main">
            <div className="brief-title">{e.title}</div>
            {e.detail && <div className="brief-detail">{e.detail}</div>}
            {e.action_label && e.action_message && (
              <button
                className="chip"
                disabled={sent[i]}
                onClick={async () => {
                  setSent((s) => ({ ...s, [i]: true }));
                  await api.send(e.action_message!);
                }}
              >
                {sent[i] ? 'On it' : e.action_label}
              </button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function FollowUps({ list }: { list: FollowUp[] }) {
  const [sent, setSent] = useState<Record<number, boolean>>({});
  return (
    <div className="follow-ups">
      {list.map((f, i) => (
        <button
          key={i}
          className="chip"
          disabled={sent[i]}
          onClick={async () => {
            setSent((s) => ({ ...s, [i]: true }));
            await api.send(f.message);
          }}
        >
          {sent[i] ? 'On it' : f.label}
        </button>
      ))}
    </div>
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
