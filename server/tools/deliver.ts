import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { CardData, FileEntry, Item } from '../../shared/types';
import { broadcast } from '../bus';
import { config } from '../config';
import { files, newId, pages, tasks, tx } from '../db';
import { deliverySource } from '../delivery';
import { type ActiveRun, type Origin, channelOfSpec, newItem, put, putPage, saveRunMeta } from '../runs/state';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const MEDIA_RE = /MEDIA:\s*((?:\/|[A-Za-z]:[\\/])[^\s`'")\]>]+)/g;
export const stripMedia = (text: string) => text.replace(MEDIA_RE, '').replace(/\n{3,}/g, '\n\n').trim();
export const mediaPaths = (text: string): string[] => [...text.matchAll(MEDIA_RE)].map((m) => m[1]);

export const backgroundTask = (taskId: string | null) => !!taskId && !!tasks.get(taskId)?.background;
export const pageOf = (taskId: string | null) => {
  const pageId = taskId ? tasks.get(taskId)?.page_id : undefined;
  return pageId ? pages.get(pageId) : null;
};

export function postCard(card: CardData, o: Origin): Item {
  if (o.run) {
    closeSegment(o.run);
    o.run.cards++;
    saveRunMeta(o.run);
  }
  const withChannel = { ...card, task_id: o.taskId ?? undefined, session_id: o.sessionId, channel_id: o.channelId };
  return put(newItem('card', { card: withChannel, run_id: o.run?.id ?? null, task_id: o.taskId, channel_id: o.channelId }));
}

export function closeSegment(run: ActiveRun) {
  run.pendingWs = '';
  if (run.segText.trim()) run.lastText = run.segText;
  run.segText = '';
  const a = run.assistant;
  if (!a) return;
  run.assistant = null;
  const text = a.text ?? '';
  a.text = stripMedia(text);
  a.streaming = false;
  put(a);
  run.dirtyMeta = true;
  saveRunMeta(run);
  deliverMedia(run, text);
}

/** Hermes marks files it produced with `MEDIA:/abs/path` (or `MEDIA:C:\...`); hand each one over like deliver_file. */
export function deliverMedia(run: ActiveRun, text: string) {
  for (const p of mediaPaths(text)) {
    try {
      deliverFile({ path: p, title: basename(p) }, { sessionId: run.spec.sessionId, taskId: run.spec.taskId ?? null, channelId: channelOfSpec(run.spec) });
    } catch (e: any) {
      console.warn('[media]', p, e?.message);
    }
  }
}

export function deliverFile(a: { path: string; title: string; summary?: string }, o: Origin): FileEntry {
  const src = deliverySource(a.path);
  const st = statSync(src);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > 50 * 1024 * 1024) throw new Error('file is over 50 MB');
  const id = newId();
  const name = basename(a.path);
  const dir = join(config.dataDir, 'files', id);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  const mime = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
  // A page refresh's file replaces the page's current version, but only if it's the same kind of file, so a
  // stray screenshot or CSV from the same run can't take the dashboard's place.
  const page = pageOf(o.taskId);
  const current = page ? files.get(page.file_id) : null;
  const version = page && (!current || current.entry.mime === mime) ? page : null;
  const entry: FileEntry = {
    id,
    title: a.title,
    name,
    mime,
    size: st.size,
    task_id: o.taskId,
    ...(version && { page_id: version.id }),
    created_at: Date.now(),
  };
  try {
    copyFileSync(src, dest);
    // The new file and the standing page's pointer to it are one unit: a crash between them leaves the page serving a
    // version the file table has already replaced.
    tx(() => {
      files.add(entry, dest);
      if (version) putPage({ ...version, file_id: id, refreshed_at: entry.created_at });
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  broadcast({ type: 'file', file: entry });
  // A background task's files arrive together on its handover card instead of one card each mid-run.
  if (!backgroundTask(o.taskId)) postCard({ type: 'file', title: a.title, body: a.summary || undefined, file_id: id, status: 'info' }, o);
  return entry;
}
