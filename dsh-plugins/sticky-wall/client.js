window.__ModuleLoader__.load({
  id: '@local/sticky-wall',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef } = React;

    const NS = 'sticky-wall';
    const STORAGE_KEY = 'dsh.stickyWall.notes.v1';
    const PANEL_ID = 'sticky-wall';

    const COLORS = [
      { id: 'amber', accent: '#e8a33d' },
      { id: 'rose', accent: '#e0678c' },
      { id: 'sky', accent: '#4a9fd8' },
      { id: 'mint', accent: '#3fae86' },
      { id: 'violet', accent: '#8f76e0' },
    ];

    const EN = {
      'entry.label': 'Sticky wall',
      'panel.title': 'Sticky wall',
      'search.placeholder': 'Search notes',
      'search.clear': 'Clear search',
      'composer.placeholder': 'Jot an idea down…',
      'composer.hint': '⌘/Ctrl + ↵ to add',
      'composer.add': 'Add note',
      'count.none': 'No notes yet',
      'count.one': '1 note',
      'count.many': 'notes',
      'empty.title': 'This wall is empty',
      'empty.hint': 'Drop a thought above — it stays on the wall until you delete it.',
      'empty.search': 'No notes match this search.',
      'note.edit': 'Edit note',
      'note.save': 'Save',
      'note.cancel': 'Cancel',
      'note.pin': 'Pin note',
      'note.unpin': 'Unpin note',
      'note.delete': 'Delete note',
      'color.amber': 'Amber',
      'color.rose': 'Rose',
      'color.sky': 'Sky',
      'color.mint': 'Mint',
      'color.violet': 'Violet',
      'time.now': 'just now',
      'time.minute': 'm ago',
      'time.hour': 'h ago',
      'time.day': 'd ago',
      'undo.message': 'Note deleted',
      'undo.action': 'Undo',
      'storage.blocked': 'This browser is blocking local storage, so notes will not persist.',
      'storage.unreadable': 'Saved notes could not be read, so the wall started empty. Your next change replaces that unreadable copy.',
    };

    const runtime = {
      t: (key) => EN[key] || key,
      locale: null,
    };

    function accentOf(colorId) {
      const hit = COLORS.find((color) => color.id === colorId);
      return (hit || COLORS[0]).accent;
    }

    function makeId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function tiltOf(id) {
      let seed = 0;
      for (let index = 0; index < id.length; index += 1) {
        seed = (seed * 31 + id.charCodeAt(index)) | 0;
      }
      const step = (Math.abs(seed) % 5) - 2;
      return (step * 0.36).toFixed(2) + 'deg';
    }

    /**
     * Read the wall from localStorage.
     *
     * `readable` is false when the stored value exists but could not be parsed
     * into a note list. The caller must then avoid the mount-time write, so a
     * damaged value is preserved instead of being overwritten with `[]`.
     */
    function loadNotes() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null || raw === '') return { notes: [], readable: true };
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return { notes: [], readable: false };
        const notes = [];
        const seen = new Set();
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const text = typeof item.text === 'string' ? item.text : '';
          if (!text.trim()) continue;
          const color = COLORS.some((entry) => entry.id === item.color) ? item.color : COLORS[0].id;
          const stamp = Date.now();
          const createdAt =
            Number.isFinite(item.createdAt) && item.createdAt > 0 ? Math.min(item.createdAt, stamp) : stamp;
          const updatedAt =
            Number.isFinite(item.updatedAt) && item.updatedAt > 0 ? Math.min(item.updatedAt, stamp) : createdAt;
          let id = typeof item.id === 'string' && item.id ? item.id : makeId();
          if (seen.has(id)) id = makeId();
          seen.add(id);
          notes.push({
            id,
            text,
            color,
            pinned: item.pinned === true,
            createdAt,
            updatedAt,
          });
        }
        return { notes, readable: true };
      } catch (error) {
        return { notes: [], readable: false };
      }
    }

    function persistNotes(notes) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
        return true;
      } catch (error) {
        return false;
      }
    }

    let dayFormatter;
    function shortDate(stamp) {
      if (!dayFormatter) {
        try {
          dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
        } catch (error) {
          return new Date(stamp).toLocaleDateString();
        }
      }
      try {
        return dayFormatter.format(stamp);
      } catch (error) {
        return new Date(stamp).toLocaleDateString();
      }
    }

    function whenLabel(stamp, now) {
      const t = runtime.t;
      const seconds = Math.max(0, (now - stamp) / 1000);
      if (seconds < 60) return t('time.now');
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + t('time.minute');
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + t('time.hour');
      const days = Math.floor(hours / 24);
      if (days < 7) return days + t('time.day');
      return shortDate(stamp);
    }

    function useTranslate() {
      const [, setRevision] = useState(0);
      useEffect(() => {
        const locale = runtime.locale;
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => setRevision((value) => value + 1));
      }, []);
      return runtime.t;
    }

    function glyph(children, size) {
      const edge = size || 14;
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        ...children,
      );
    }

    function PinGlyph() {
      return glyph([
        h('path', { key: 'head', d: 'M5.7 2.6h4.6l-.8 3.1 2.2 2.2v1.2H4.3V7.9l2.2-2.2z' }),
        h('path', { key: 'stem', d: 'M8 9.1v4.3' }),
      ]);
    }

    function TrashGlyph() {
      return glyph([
        h('path', { key: 'top', d: 'M2.8 4.4h10.4' }),
        h('path', { key: 'lid', d: 'M6.4 4.4V3h3.2v1.4' }),
        h('path', { key: 'body', d: 'M4.4 4.4l.6 8.4h6l.6-8.4' }),
        h('path', { key: 'line-a', d: 'M6.7 6.9v3.6' }),
        h('path', { key: 'line-b', d: 'M9.3 6.9v3.6' }),
      ]);
    }

    function CloseGlyph() {
      return glyph([
        h('path', { key: 'a', d: 'M4 4l8 8' }),
        h('path', { key: 'b', d: 'M12 4l-8 8' }),
      ], 12);
    }

    /** Icon inside the sidebar's own panel row button (16px wide, 18px rail). */
    function StickyIcon(props) {
      const edge = props && props.size ? props.size : 16;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', {
          key: 'sheet',
          d: 'M5 5.75A1.75 1.75 0 0 1 6.75 4h10.5A1.75 1.75 0 0 1 19 5.75v8.6c0 .46-.18.9-.51 1.23l-2.9 2.9a1.75 1.75 0 0 1-1.24.52H6.75A1.75 1.75 0 0 1 5 17.25z',
        }),
        h('path', { key: 'fold', d: 'M19 14.2h-2.3a1.3 1.3 0 0 0-1.3 1.3V18' }),
        h('path', { key: 'line-a', d: 'M8.4 8.6h7.2' }),
        h('path', { key: 'line-b', d: 'M8.4 12h4.8' }),
      );
    }

    function WallPanel() {
      const t = useTranslate();
      const [initial] = useState(loadNotes);
      const [notes, setNotes] = useState(initial.notes);
      const [draft, setDraft] = useState('');
      const [draftColor, setDraftColor] = useState(COLORS[0].id);
      const [query, setQuery] = useState('');
      const [editingId, setEditingId] = useState(null);
      const [editText, setEditText] = useState('');
      const [undo, setUndo] = useState(null);
      const [storageNotice, setStorageNotice] = useState(initial.readable ? null : 'storage.unreadable');
      const [now, setNow] = useState(() => Date.now());

      const composerRef = useRef(null);
      const undoTimer = useRef(null);
      const loadedNotes = useRef(initial.notes);

      useEffect(() => {
        // Never write back the value we just read: an unreadable snapshot must
        // survive until the user actually changes the wall.
        if (notes === loadedNotes.current) return;
        setStorageNotice(persistNotes(notes) ? null : 'storage.blocked');
      }, [notes]);

      useEffect(() => {
        const tick = window.setInterval(() => setNow(Date.now()), 60000);
        return () => window.clearInterval(tick);
      }, []);

      useEffect(() => {
        const input = composerRef.current;
        if (input) input.focus();
        return () => {
          if (undoTimer.current) window.clearTimeout(undoTimer.current);
        };
      }, []);

      useEffect(() => {
        const input = composerRef.current;
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      }, [draft]);

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = needle
          ? notes.filter((note) => note.text.toLowerCase().includes(needle))
          : notes;
        return filtered.slice().sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.createdAt - a.createdAt;
        });
      }, [notes, query]);

      const countLabel =
        notes.length === 0
          ? t('count.none')
          : notes.length === 1
            ? t('count.one')
            : notes.length + ' ' + t('count.many');

      function focusComposer() {
        const input = composerRef.current;
        if (input) input.focus();
      }

      function addNote() {
        const text = draft.trim();
        if (!text) {
          focusComposer();
          return;
        }
        const stamp = Date.now();
        const note = {
          id: makeId(),
          text,
          color: draftColor,
          pinned: false,
          createdAt: stamp,
          updatedAt: stamp,
        };
        setNotes((previous) => [note, ...previous]);
        setDraft('');
        // Keep the new note in view instead of letting an active filter hide it.
        setQuery('');
        setDraftColor((current) => {
          const index = COLORS.findIndex((color) => color.id === current);
          return COLORS[(index + 1) % COLORS.length].id;
        });
        window.requestAnimationFrame(focusComposer);
      }

      /** Save the open editor without deleting a note that was cleared. */
      function commitPendingEdit() {
        if (!editingId) return;
        const text = editText.trim();
        if (text) {
          const stamp = Date.now();
          setNotes((previous) =>
            previous.map((note) => (note.id === editingId ? { ...note, text, updatedAt: stamp } : note)),
          );
        }
        cancelEdit();
      }

      function startEdit(note) {
        // Switching notes must not throw away the open editor's draft.
        if (editingId && editingId !== note.id) commitPendingEdit();
        setEditingId(note.id);
        setEditText(note.text);
      }

      function cancelEdit() {
        setEditingId(null);
        setEditText('');
      }

      function removeNote(id) {
        const index = notes.findIndex((note) => note.id === id);
        if (index < 0) return;
        const removed = notes[index];
        setNotes(notes.filter((note) => note.id !== id));
        if (editingId === id) cancelEdit();
        setUndo({ note: removed, index });
        if (undoTimer.current) window.clearTimeout(undoTimer.current);
        undoTimer.current = window.setTimeout(() => {
          undoTimer.current = null;
          setUndo(null);
        }, 6000);
      }

      function commitEdit() {
        if (!editingId) return;
        const text = editText.trim();
        if (!text) {
          removeNote(editingId);
          return;
        }
        const stamp = Date.now();
        setNotes((previous) =>
          previous.map((note) => (note.id === editingId ? { ...note, text, updatedAt: stamp } : note)),
        );
        cancelEdit();
      }

      function togglePin(id) {
        setNotes((previous) =>
          previous.map((note) => (note.id === id ? { ...note, pinned: !note.pinned } : note)),
        );
      }

      function undoRemove() {
        if (!undo) return;
        const restored = undo;
        setNotes((previous) => {
          const copy = previous.slice();
          copy.splice(Math.min(restored.index, copy.length), 0, restored.note);
          return copy;
        });
        setUndo(null);
        if (undoTimer.current) {
          window.clearTimeout(undoTimer.current);
          undoTimer.current = null;
        }
        window.requestAnimationFrame(focusComposer);
      }

      function renderNote(note) {
        const accent = accentOf(note.color);
        const isEditing = editingId === note.id;
        return h(
          'article',
          {
            key: note.id,
            className: 'sw-note' + (note.pinned ? ' is-pinned' : '') + (isEditing ? ' is-editing' : ''),
            style: { '--sw-accent': accent, '--sw-tilt': tiltOf(note.id) },
          },
          isEditing
            ? h('textarea', {
                className: 'sw-note-edit',
                value: editText,
                autoFocus: true,
                spellCheck: true,
                'aria-label': t('note.edit'),
                onChange: (event) => setEditText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelEdit();
                    return;
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    commitEdit();
                  }
                },
              })
            : h(
                'div',
                {
                  className: 'sw-note-text',
                  role: 'button',
                  tabIndex: 0,
                  title: t('note.edit'),
                  onClick: () => startEdit(note),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      startEdit(note);
                    }
                  },
                },
                note.text,
              ),
          h(
            'footer',
            { className: 'sw-note-foot' },
            h(
              'div',
              { className: 'sw-note-meta' },
              note.pinned
                ? h('span', { className: 'sw-pin-mark', 'aria-hidden': 'true' }, h(PinGlyph))
                : null,
              h(
                'time',
                { className: 'sw-note-time', dateTime: new Date(note.updatedAt).toISOString() },
                whenLabel(note.updatedAt, now),
              ),
            ),
            isEditing
              ? h(
                  'div',
                  { className: 'sw-note-actions sw-actions-visible' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sw-text-button',
                      onClick: cancelEdit,
                    },
                    t('note.cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sw-text-button is-primary',
                      onClick: commitEdit,
                    },
                    t('note.save'),
                  ),
                )
              : h(
                  'div',
                  { className: 'sw-note-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sw-icon-button',
                      'aria-label': note.pinned ? t('note.unpin') : t('note.pin'),
                      'aria-pressed': note.pinned,
                      title: note.pinned ? t('note.unpin') : t('note.pin'),
                      onClick: () => togglePin(note.id),
                    },
                    h(PinGlyph),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sw-icon-button is-danger',
                      'aria-label': t('note.delete'),
                      title: t('note.delete'),
                      onClick: () => removeNote(note.id),
                    },
                    h(TrashGlyph),
                  ),
                ),
          ),
        );
      }

      return h(
        'div',
        { className: 'sw-root' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'sw-header' },
          h(
            'div',
            { className: 'sw-heading' },
            h('h1', { className: 'sw-title' }, t('panel.title')),
            h('span', { className: 'sw-count' }, countLabel),
          ),
          h(
            'div',
            { className: 'sw-tools' },
            h(
              'div',
              { className: 'sw-search-wrap' },
              h('input', {
                className: 'sw-search',
                type: 'search',
                value: query,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.placeholder'),
                onChange: (event) => setQuery(event.target.value),
              }),
              query
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'sw-icon-button sw-search-clear',
                      'aria-label': t('search.clear'),
                      title: t('search.clear'),
                      onClick: () => setQuery(''),
                    },
                    h(CloseGlyph),
                  )
                : null,
            ),
          ),
        ),
        h(
          'div',
          { className: 'sw-body' },
          h(
            'div',
            { className: 'sw-composer' },
            h('textarea', {
              ref: composerRef,
              className: 'sw-input',
              value: draft,
              rows: 2,
              spellCheck: true,
              placeholder: t('composer.placeholder'),
              'aria-label': t('composer.placeholder'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  addNote();
                  return;
                }
                if (event.key === 'Escape' && draft) {
                  event.preventDefault();
                  setDraft('');
                }
              },
            }),
            h(
              'div',
              { className: 'sw-composer-foot' },
              h(
                'div',
                { className: 'sw-swatches' },
                COLORS.map((color) =>
                  h('button', {
                    key: color.id,
                    type: 'button',
                    className: 'sw-swatch' + (draftColor === color.id ? ' is-selected' : ''),
                    'aria-label': t('color.' + color.id),
                    'aria-pressed': draftColor === color.id,
                    title: t('color.' + color.id),
                    style: { '--sw-swatch': color.accent },
                    onClick: () => setDraftColor(color.id),
                  }),
                ),
              ),
              h('span', { className: 'sw-hint' }, t('composer.hint')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sw-primary',
                  disabled: !draft.trim(),
                  onClick: addNote,
                },
                t('composer.add'),
              ),
            ),
          ),
          storageNotice
            ? h('p', { className: 'sw-warning', role: 'status' }, t(storageNotice))
            : null,
          h(
            'div',
            { className: 'sw-wall' },
            visible.length === 0
              ? h(
                  'div',
                  { className: 'sw-empty' },
                  h(
                    'div',
                    { className: 'sw-empty-note', 'aria-hidden': 'true' },
                    h(StickyIcon, { size: 22 }),
                  ),
                  h('p', { className: 'sw-empty-title' }, query.trim() ? t('empty.search') : t('empty.title')),
                  query.trim() ? null : h('p', { className: 'sw-empty-hint' }, t('empty.hint')),
                )
              : visible.map(renderNote),
          ),
        ),
        undo
          ? h(
              'div',
              { className: 'sw-undo', role: 'status' },
              h('span', null, t('undo.message')),
              h(
                'button',
                { type: 'button', className: 'sw-text-button is-primary', onClick: undoRemove },
                t('undo.action'),
              ),
            )
          : null,
      );
    }

    const CSS = `
.sw-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5;font-family:inherit}
.sw-root *,.sw-root *::before,.sw-root *::after{box-sizing:border-box}
.sw-header{display:flex;align-items:center;gap:12px;flex:none;height:54px;padding:0 20px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.sw-heading{display:flex;align-items:baseline;gap:8px;min-width:0}
.sw-title{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
.sw-count{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sw-tools{display:flex;align-items:center;gap:4px;margin-left:auto;min-width:0}
.sw-search-wrap{position:relative;display:flex;min-width:0}
.sw-search{width:190px;min-width:96px;max-width:42vw;height:28px;padding:0 28px 0 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;
  outline:none;transition:border-color .15s ease}
.sw-search:focus{border-color:var(--dsw-alias-brand-primary)}
.sw-search::placeholder{color:var(--dsw-alias-label-secondary)}
.sw-search::-webkit-search-cancel-button{display:none}
.sw-search-clear{position:absolute;right:3px;top:3px;width:22px;height:22px}
.sw-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:14px 20px 0}
.sw-composer{flex:none;padding:12px 12px 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.sw-input{display:block;width:100%;height:2.9em;min-height:2.9em;max-height:180px;padding:0;border:none;outline:none;
  resize:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.45}
.sw-input::placeholder{color:var(--dsw-alias-label-secondary)}
.sw-composer-foot{display:flex;align-items:center;gap:10px;margin-top:8px}
.sw-swatches{display:flex;align-items:center;gap:6px}
.sw-swatch{width:18px;height:18px;padding:0;border-radius:50%;cursor:pointer;
  border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);
  background:var(--sw-swatch);transition:transform .12s ease,box-shadow .12s ease}
.sw-swatch:hover{transform:scale(1.12)}
.sw-swatch.is-selected{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 4px var(--sw-swatch)}
.sw-hint{margin-left:2px;font-size:11px;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sw-primary{margin-left:auto;height:28px;padding:0 12px;border:none;border-radius:8px;cursor:pointer;
  background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:12px;font-weight:600}
.sw-primary:disabled{opacity:.45;cursor:default}
.sw-warning{margin:0;font-size:12px;color:var(--dsw-alias-state-warn-primary)}
.sw-wall{flex:1;min-height:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));
  grid-auto-rows:min-content;align-content:start;gap:14px;padding:2px 2px 32px;overflow-y:auto;overscroll-behavior:contain}
.sw-note{position:relative;display:flex;flex-direction:column;gap:10px;min-height:118px;padding:14px 14px 8px;
  border-radius:14px;border:1px solid color-mix(in srgb, var(--sw-accent) 44%, var(--dsw-alias-border-l1));
  background:color-mix(in srgb, var(--sw-accent) 17%, var(--dsw-alias-bg-layer-1));
  transform:rotate(var(--sw-tilt,0deg));transform-origin:50% 0;
  box-shadow:0 1px 2px rgba(0,0,0,.05),0 10px 22px -20px rgba(0,0,0,.55);
  transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.sw-note:hover{transform:rotate(0deg) translateY(-1px);
  box-shadow:0 2px 4px rgba(0,0,0,.06),0 16px 28px -20px rgba(0,0,0,.5)}
.sw-note.is-pinned{border-color:color-mix(in srgb, var(--sw-accent) 78%, var(--dsw-alias-border-l2))}
.sw-note.is-editing{transform:rotate(0deg)}
.sw-note-text{flex:1;min-height:0;white-space:pre-wrap;overflow-wrap:anywhere;cursor:text;border-radius:6px}
.sw-note-text:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sw-note-edit{flex:1;min-height:76px;width:100%;padding:0;border:none;outline:none;resize:vertical;
  background:transparent;color:inherit;font:inherit;line-height:1.5}
.sw-note-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;
  font-size:11px;color:var(--dsw-alias-label-secondary)}
.sw-note-meta{display:flex;align-items:center;gap:6px;min-width:0}
.sw-pin-mark{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary);opacity:.85}
.sw-note-time{white-space:nowrap}
.sw-note-actions{display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .12s ease}
.sw-note:hover .sw-note-actions,.sw-note:focus-within .sw-note-actions,.sw-actions-visible{opacity:1}
@media (hover:none){.sw-note-actions{opacity:1}}
.sw-icon-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;
  border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sw-icon-button:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  color:var(--dsw-alias-label-primary)}
.sw-icon-button[aria-pressed="true"]{color:var(--dsw-alias-brand-primary)}
.sw-icon-button.is-danger:hover{color:var(--dsw-alias-state-error-primary)}
.sw-text-button{height:24px;padding:0 7px;border:none;border-radius:6px;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:500}
.sw-text-button:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  color:var(--dsw-alias-label-primary)}
.sw-text-button.is-primary{color:var(--dsw-alias-brand-primary);font-weight:600}
.sw-empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  padding:64px 24px;text-align:center;color:var(--dsw-alias-label-secondary)}
.sw-empty-note{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:4px;
  border-radius:12px;border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-brand-primary) 12%);
  color:var(--dsw-alias-label-secondary)}
.sw-empty-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sw-empty-hint{margin:0;max-width:330px;font-size:12px;line-height:1.55}
.sw-undo{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:5;
  display:flex;align-items:center;gap:14px;padding:7px 10px 7px 14px;border-radius:10px;font-size:12px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 10px 26px -14px rgba(0,0,0,.5)}
`;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        runtime.locale = ctx.locale;
        runtime.t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : runtime.t;

        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'sticky-wall locale');

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => runtime.t('entry.label'),
            },
            StickyIcon,
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, WallPanel),
        );
      },
    };
  },
});
