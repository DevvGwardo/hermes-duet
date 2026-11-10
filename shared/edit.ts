// What a delivered file may be edited into. Kept dependency-free (and out of the React layer) so the server
// route and the web viewer agree on one rule and it can be tested without a DOM.

/** The largest edited file we accept, in bytes. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/**
 * Extensions we treat as text even when the delivered mime type is generic: a `.tsv` is not in the delivery
 * MIME table, so it arrives as application/octet-stream and only its name says it is editable.
 */
const TEXT_EXTENSIONS = ['.md', '.csv', '.tsv', '.json', '.html', '.txt'];

const EXTENSION = /\.([a-z0-9]+)$/i;

/**
 * Whether the viewer may offer an editor for this file. Text-ish mime types, JSON, XML and SVG, plus the usual
 * document extensions by name. A PDF, a photo or a binary is refused: there is no source to edit.
 */
export function isEditableMime(name: string, mime: string): boolean {
  const type = String(mime ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type.startsWith('text/')) return true;
  if (type === 'application/json' || type === 'application/xml' || type === 'image/svg+xml') return true;
  const ext = EXTENSION.exec(String(name ?? '').toLowerCase());
  return !!ext && TEXT_EXTENSIONS.includes(`.${ext[1]}`);
}
