import type { Attachment } from '../../../shared/types';
import { Icon } from '../ui';

/**
 * Files on a message: photos as thumbnails, a voice memo with its own player, anything else as a chip. The URLs point
 * at /api/uploads, which serves them sandboxed and only to a paired device.
 */
export function Attachments({ list, onRemove }: { list: Attachment[]; onRemove?: (id: string) => void }) {
  if (!list.length) return null;
  return (
    <ul className="attachments">
      {list.map((a) => (
        <li key={a.id} className={`attachment ${a.kind}`}>
          {a.kind === 'image' ? (
            <a href={`/api/uploads/${a.id}`} target="_blank" rel="noopener noreferrer" className="attachment-thumb">
              <img src={`/api/uploads/${a.id}`} alt={a.name} loading="lazy" />
            </a>
          ) : a.kind === 'audio' ? (
            <span className="attachment-audio">
              <Icon.speaker size={16} />
              <audio controls preload="metadata" src={`/api/uploads/${a.id}`} />
            </span>
          ) : (
            <a className="attachment-file" href={`/api/uploads/${a.id}`} target="_blank" rel="noopener noreferrer">
              <Icon.file size={16} />
              {a.name}
            </a>
          )}
          {onRemove && (
            <button className="attachment-remove" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}>
              <Icon.close size={13} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}