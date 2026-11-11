import type { CardData, Task, TaskStep } from '../../shared/types';
import { DRAFT_MAX, REPLACED, WITHDRAWN, approvalPush, replaceRefusal, withdrawRefusal } from '../approval';
import { briefCard, briefTitle, notifyRefusal } from '../brief';
import { broadcast } from '../bus';
import { inQuietHours, localParts } from '../clock';
import { config } from '../config';
import { channels, files, items, kv, newId, pages, settings, tasks } from '../db';
import { followUps } from '../handover';
import { MAX_PAGES, pageInput, refreshTime } from '../pages';
import { money, paymentCard, paymentInput, providerFromEnv } from '../payments';
import { notify } from '../push';
import { scheduleLabel } from '../routines';
import { removePage, saveRoutine, startTask } from '../runs/manager';
import {
  type ActiveRun,
  CHANNEL_ORIGIN_PREFIX,
  MAIN_ORIGIN,
  type Origin,
  activeRuns,
  cardUrl,
  channelOfSpec,
  expireBriefRetries,
  firstLine,
  lanes,
  liveChannel,
  mainLane,
  markTaskWaiting,
  pushSafe,
  put,
  putPage,
  putTask,
  removeRoutine,
  saveRunMeta,
} from '../runs/state';
import { approvalPolicyRefusal, scanOutbound, validateApprovalFields } from '../safety';
import { GENERAL_CHANNEL } from '../schema';
import { parseSources, type SourceKind } from '../sources';
import { withAgentDone } from '../taskstatus';
import { backgroundTask, deliverFile, pageOf, postCard } from './deliver';

/** Work out which session a tool call came from. */
async function originOf(tool: string, taskId: unknown): Promise<Origin> {
  const explicit = typeof taskId === 'string' ? taskId.trim() : '';
  // "main" is how a turn in the main conversation answers the ambiguity error below when background work is running.
  if (explicit === MAIN_ORIGIN) return mainOrigin();
  if (explicit.startsWith(CHANNEL_ORIGIN_PREFIX)) {
    const cid = explicit.slice(CHANNEL_ORIGIN_PREFIX.length).trim();
    const ch = cid ? channels.get(cid) : null;
    if (!ch || ch.archived_at != null) {
      throw new Error(`No Hermes Duet channel ${cid || explicit}, so nothing was posted. Check the channel id, or pass "main" for the main conversation.`);
    }
    const run = lanes.get(ch.session_id)?.active ?? undefined;
    return { sessionId: ch.session_id, taskId: null, channelId: ch.id, run };
  }
  if (explicit) {
    const sid = tasks.sessionOf(explicit);
    if (!sid) throw new Error(`No Hermes Duet task ${explicit}, so nothing was posted. Check the id in your instructions, or pass "main" for the main conversation.`);
    const run = lanes.get(sid)?.active ?? undefined;
    return { sessionId: sid, taskId: explicit, channelId: channels.forTask(tasks.get(explicit)), run };
  }
  // With one run (or none) there is nothing to guess. With several, the run that just started this tool has it in its
  // step list once that event lands, so give it a moment; if two runs are using the same tool, refuse rather than
  // pick — a card or a file filed under the wrong task can't be fixed by the user afterwards.
  for (let i = 0; i < 8; i++) {
    const act = activeRuns();
    if (act.length <= 1) break;
    const hits = act.filter((r) => r.steps.some((s) => s.status === 'running' && s.name.endsWith(tool)));
    if (hits.length === 1) return originOfRun(hits[0]);
    if (hits.length > 1) throw ambiguousOrigin(tool, hits);
    await Bun.sleep(100);
  }
  const act = activeRuns();
  if (act.length > 1) throw ambiguousOrigin(tool, act);
  return act.length ? originOfRun(act[0]) : mainOrigin();
}

function originOfRun(run: ActiveRun): Origin {
  return { sessionId: run.spec.sessionId, taskId: run.spec.taskId ?? null, channelId: channelOfSpec(run.spec), run };
}

function mainOrigin(): Origin {
  const m = mainLane();
  const spec = m.active?.spec ?? { kind: 'chat', sessionId: m.sessionId, input: '' };
  return { sessionId: m.sessionId, taskId: null, channelId: channelOfSpec(spec), run: m.active ?? undefined };
}

function runOriginLabel(r: ActiveRun): { where: string; arg: string } {
  if (r.spec.taskId) return { where: `task ${r.spec.taskId}`, arg: r.spec.taskId };
  const chId = channelOfSpec(r.spec);
  if (chId !== GENERAL_CHANNEL) {
    const ch = channels.get(chId);
    return { where: ch ? `channel #${ch.name} (${chId})` : `channel ${chId}`, arg: `"${CHANNEL_ORIGIN_PREFIX}${chId}"` };
  }
  return { where: 'the main conversation', arg: '"main"' };
}

/**
 * More than one live turn could have called this tool, and they are not distinguishable. The call is dropped and the
 * agent is told how to place it, so a file or a card never lands in a conversation it does not belong to.
 */
function ambiguousOrigin(tool: string, runs: ActiveRun[]): Error {
  const labels = runs.map(runOriginLabel);
  const where = labels.map((l) => l.where);
  const remedy = [...new Set(labels.map((l) => l.arg))].join(' or ');
  return new Error(
    `Nothing was posted: ${runs.length} turns are running at once (${where.join(', ')}) and more than one is using ${tool}, so I can't tell which one this belongs to. Call ${tool} again with task_id: ${remedy}.`,
  );
}

/**
 * Whether a source's local id names something real. Anything else is the
 * agent inventing provenance, so it fails the tool call instead of posting a
 * chip that opens nothing. url/connector/other have no registry; their label
 * is the citation and parseSources already requires it.
 */
function sourceExists(kind: SourceKind, id: string): boolean {
  switch (kind) {
    case 'item':
      return items.get(id) !== null;
    case 'task':
      return tasks.get(id) !== null;
    case 'file':
      return files.get(id) !== null;
    case 'page':
      return pages.get(id) !== null;
    default:
      return true;
  }
}

const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max));
const req = (v: unknown, name: string, max?: number) => {
  const s = str(v, max).trim();
  if (!s) throw new Error(`missing ${name}`);
  return s;
};

/**
 * The earlier card a redrafted `request_approval` / `ask` withdraws (`replaces`). It is checked before the new card
 * is posted, and `apply` expires it once the new one is up, before the push reads the badge count. `apply` returns
 * the withdrawn id for use as the push tag.
 */
function replacing(id: unknown, type: 'approval' | 'choice', o: Origin): { note: string; apply: () => string | undefined } {
  const cardId = str(id, 64).trim();
  if (!cardId) return { note: '', apply: () => undefined };
  const old = items.get(cardId);
  const refused = replaceRefusal(old, type, o.sessionId);
  if (refused || !old) return { note: ` Card ${cardId} was not replaced: ${refused}.`, apply: () => undefined };
  return {
    note: ` It replaces card ${cardId}, which is withdrawn, so only the new card can be answered.`,
    apply: () => {
      put({ ...old, card: { ...old.card!, status: 'expired', decision: REPLACED, decided_at: Date.now() } });
      return cardId;
    },
  };
}

/** save_page: create, update or remove a standing page. */
async function savePage(args: Record<string, unknown>, callerTask?: string | null): Promise<string> {
  const pageId = str(args.page_id, 64).trim();
  const existing = pageId ? pages.get(pageId) : null;
  if (pageId && !existing) throw new Error(`no page ${pageId}`);
  if (args.remove === true) {
    if (!existing) throw new Error('remove needs page_id');
    await removePage(existing.id, callerTask);
    return `Page ${existing.id} ("${existing.title}") removed. It no longer refreshes; its files stay in the Make tab.`;
  }
  const input = pageInput(args, existing);
  if (!files.get(input.file_id)) throw new Error(`no file ${input.file_id}; pass the id deliver_file returned`);
  const s = settings.get();
  const at = refreshTime(s.brief_time);
  if (existing) {
    putPage({ ...existing, ...input });
    markVersion(input.file_id, existing.id);
    return `Page ${existing.id} ("${input.title}") updated. It still refreshes every day at ${at}.`;
  }
  if (pages.all().length >= MAX_PAGES) throw new Error(`there are already ${MAX_PAGES} standing pages; update or remove one first`);
  const now = Date.now();
  // The first version was just built, so today counts as refreshed.
  const page = putPage({ id: newId(), ...input, refreshed_on: localParts(s.timezone).date, refreshed_at: now, created_at: now, updated_at: now });
  markVersion(input.file_id, page.id);
  return `Saved standing page ${page.id} ("${page.title}"). It refreshes every day at ${at}, 30 minutes before the morning brief, as a background task that delivers the new version in its place. Use page_id="${page.id}" to change it later, or with remove: true to stop it.`;
}

/**
 * The file save_page named was delivered before the page existed (usually from chat), so deliverFile couldn't mark it
 * as a version of the page; mark it now, so Make lists it once instead of next to every later refresh.
 */
function markVersion(fileId: string, pageId: string) {
  const f = files.get(fileId);
  if (!f || f.entry.page_id === pageId) return;
  broadcast({ type: 'file', file: files.update({ ...f.entry, page_id: pageId }) });
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  kv.set('last_tool_call_at', Date.now());
  const o = await originOf(name, args.task_id);
  switch (name) {
    case 'request_approval': {
      const swap = replacing(args.replaces, 'approval', o);
      // Structured fields first: a malformed card never posts. Then the hard-block policy, then the
      // outbound secret scan — both throw before anything is stored, so a blocked card never exists to be tapped.
      const fields = validateApprovalFields(args);
      const title = req(args.title, 'title', 140);
      const summary = str(args.summary, 8000);
      const draft = str(args.draft, DRAFT_MAX).trim() || undefined;
      const refused = approvalPolicyRefusal({ action: fields.action, title, summary, destination: fields.destination, content: fields.content, draft });
      if (refused) throw new Error(refused);
      const seenFindings = new Set<string>();
      const findings = [title, draft, fields.content, summary]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .flatMap((s) => scanOutbound(s))
        .filter((f) => {
          const key = `${f.tier}:${f.label}:${f.redacted}`;
          if (seenFindings.has(key)) return false;
          seenFindings.add(key);
          return true;
        });
      const blocked = findings.filter((f) => f.tier === 'never_share');
      if (blocked.length) {
        const kinds = [...new Set(blocked.map((f) => f.label))].join(', ');
        const hints = blocked.map((f) => `${f.label} (${f.redacted})`).join(', ');
        throw new Error(
          `Approval blocked: the text looks like it contains ${kinds}: ${hints}. Remove the secret and post again without it — never paste the full value.`,
        );
      }
      const consent = findings.filter((f) => f.tier === 'needs_consent');
      const scan_warning = consent.length
        ? `Contains ${[...new Set(consent.map((f) => f.label))].join(', ')} — check it before sending.`
        : undefined;
      const item = postCard(
        {
          type: 'approval',
          title,
          body: summary,
          draft,
          action_label: str(args.action_label, 30) || undefined,
          // The auditable shape of what was approved: who gets what, where. When content is absent the
          // draft is the outbound text, so it stands in rather than leaving the card ambiguous.
          action: fields.action,
          destination: fields.destination,
          recipients: fields.recipients.length ? fields.recipients : undefined,
          content: fields.content ?? draft,
          url: fields.url,
          scan_warning,
          status: 'pending',
        },
        o,
      );
      if (o.taskId) markTaskWaiting(o.taskId);
      const replaced = swap.apply();
      // Same tag as the withdrawn card's push, so the new banner takes the old one's place on the lock screen.
      pushSafe({ ...approvalPush(item), url: cardUrl(item.id, o.channelId), channel_id: o.channelId, ...(replaced && { tag: replaced }) }, { ignoreQuiet: true });
      return `Approval card ${item.id} is on the user's phone.${swap.note} They have NOT approved yet. Do not take the action now. Tell them in one short line what you're waiting on, then end your turn. You'll get "[approval ${item.id}] APPROVED" or "NOT NOW" as a new message.`;
    }
    case 'request_payment': {
      // A misconfigured provider (generic without a URL) is a setup error, not a reason to quietly downgrade to a
      // plain spend authorization, so providerFromEnv throws before anything is posted.
      const provider = providerFromEnv(process.env);
      const input = paymentInput(args, config.maxTransactionCents);
      const item = postCard(paymentCard(input, { taskId: o.taskId, cardProvider: provider?.name ?? null }), o);
      if (o.taskId) markTaskWaiting(o.taskId);
      const total = money(input.amount_cents, input.currency);
      pushSafe(
        {
          title: 'Check before I spend',
          body: `${total} at ${input.merchant}. ${input.items.map((i) => i.title).slice(0, 3).join(', ')}`,
          card_id: item.id,
          tag: item.id,
          url: cardUrl(item.id, o.channelId),
          // Spending money is consent: it always reaches the phone, like any approval.
          category: 'approval',
          channel_id: o.channelId,
        },
        { ignoreQuiet: true },
      );
      return `Payment card ${item.id} is on the user's phone: ${total} at ${input.merchant}, itemized. They have NOT approved it. Do not pay anything now. Tell them in one short line what you are waiting on, then end your turn. ${
        provider
          ? `If they approve, a single-use ${provider.name} card capped at ${total} is issued and typed into your live browser; you will get "[payment ${item.id}] APPROVED" with the last four digits.`
          : `No card provider is configured, so approval authorizes you to spend exactly ${total}; you will get "[payment ${item.id}] APPROVED".`
      }`;
    }
    case 'ask': {
      const options = Array.isArray(args.options) ? args.options.map((x) => str(x, 60).trim()).filter(Boolean).slice(0, 4) : [];
      if (options.length < 2) throw new Error('ask needs 2-4 options');
      const swap = replacing(args.replaces, 'choice', o);
      const item = postCard({ type: 'choice', title: req(args.question, 'question', 200), body: str(args.context, 4000) || undefined, options, status: 'pending' }, o);
      if (o.taskId) markTaskWaiting(o.taskId);
      const replaced = swap.apply();
      pushSafe({ title: 'Quick question', body: item.card!.title, card_id: item.id, tag: replaced ?? item.id, url: cardUrl(item.id, o.channelId), category: 'question', channel_id: o.channelId });
      return `Question card ${item.id} posted.${swap.note} End your turn now; the answer arrives as "[answer ${item.id}] …".`;
    }
    case 'withdraw_card': {
      const id = req(args.card_id, 'card_id', 64);
      const target = items.get(id);
      const refused = withdrawRefusal(target, o.sessionId);
      if (refused || !target) return `Card ${id} was not withdrawn: ${refused}.`;
      const reason = firstLine(str(args.reason, 200), 80);
      // Expired, like a replaced card: it leaves "Needs you", and the next push or app launch clears its banner.
      put({ ...target, card: { ...target.card!, status: 'expired', decision: reason ? `${WITHDRAWN}: ${reason}` : WITHDRAWN, decided_at: Date.now() } });
      return `Card ${id} withdrawn; it can no longer be tapped. Carry on from what the user said in chat.`;
    }
    case 'post_brief': {
      const morning = o.run?.spec.kind === 'brief';
      const { entries, watching, demoted, unlinked } = briefCard(args, { morning, pageFile: (id) => pages.get(id)?.file_id ?? null, lookup: sourceExists });
      const s = settings.get();
      const item = postCard(
        {
          type: 'brief',
          title: briefTitle(req(args.title, 'title', 140), entries.length),
          body: str(args.summary, 2000) || undefined,
          entries,
          watching: watching.length ? watching : undefined,
          status: 'info',
          updated_label: `Updated ${new Date().toLocaleTimeString('en-US', { timeZone: s.timezone, hour: 'numeric', minute: '2-digit' })}`,
        },
        o,
      );
      if (o.run) {
        o.run.briefs++;
        saveRunMeta(o.run);
      }
      if (morning) expireBriefRetries();
      const links = unlinked.length ? ` No standing page has the id ${unlinked.join(', ')}, so those lines don't open a page.` : '';
      // A quiet morning (Watching only) is posted but not pushed: nothing needs the user, so nothing interrupts them.
      if (!entries.length) return `Brief card ${item.id} posted with nothing to decide. It was not pushed.${links}`;
      pushSafe(
        {
          title: item.card!.title,
          // Decisions only: Watching never notifies.
          body: [...entries.slice(0, 3).map((e) => `• ${e.title}`), ...(entries.length > 3 ? [`+${entries.length - 3} more`] : [])].join('\n'),
          tag: morning ? 'brief' : 'checkin',
          url: cardUrl(item.id, o.channelId),
          category: morning ? 'brief' : 'checkin',
          channel_id: o.channelId,
        },
        { ignoreQuiet: morning },
      );
      return demoted.length
        ? `Brief card ${item.id} posted with the top ${entries.length} decisions. Moved to Watching (drafts dropped): ${demoted.join('; ')}.${links}`
        : `Brief card ${item.id} posted.${links}`;
    }
    case 'post_card': {
      const type = str(args.type) as CardData['type'];
      if (!['checklist', 'metrics', 'note'].includes(type)) throw new Error('type must be checklist, metrics or note');
      const sources = parseSources(args.sources, sourceExists);
      const patch: Partial<CardData> = { type, title: req(args.title, 'title', 140) };
      if (args.body !== undefined) patch.body = str(args.body, 8000);
      if (Array.isArray(args.checklist)) {
        patch.checklist = args.checklist
          .slice(0, 200)
          .map((c: any) => ({ text: str(c?.text, 300).trim(), done: !!c?.done }))
          .filter((c) => c.text.length > 0);
      }
      if (Array.isArray(args.metrics)) {
        patch.metrics = args.metrics
          .slice(0, 24)
          .map((m: any) => ({
            label: str(m?.label, 60).trim(),
            value: str(m?.value, 40).trim(),
            delta: str(m?.delta, 30).trim() || undefined,
            tone: ['good', 'bad', 'neutral'].includes(m?.tone) ? m.tone : undefined,
          }))
          .filter((m) => m.label.length > 0 && m.value.length > 0);
      }
      const cardId = str(args.card_id, 64).trim();
      if (cardId) {
        const existing = items.get(cardId);
        if (!existing || existing.kind !== 'card' || !existing.card || !['checklist', 'metrics', 'note'].includes(existing.card.type)) {
          throw new Error(`Card ${cardId} cannot be updated: it is not a checklist, metrics or note card.`);
        }
        if (existing.card.session_id !== o.sessionId) {
          throw new Error(`Card ${cardId} cannot be updated: it belongs to another conversation.`);
        }
        if (existing.card.type !== type) {
          throw new Error(`Card ${cardId} is a ${existing.card.type} card, so it cannot be updated as ${type}.`);
        }
        existing.card = { ...existing.card, ...patch, ...(sources !== undefined ? { sources } : {}), updated_label: undefined };
        put(existing);
        return `Updated card ${existing.id}.`;
      }
      const item = postCard({ ...(patch as CardData), ...(sources !== undefined ? { sources } : {}), status: 'info' }, o);
      return `Card ${item.id} posted. Pass card_id="${item.id}" to update it in place.`;
    }
    case 'deliver_file': {
      const entry = deliverFile({ path: req(args.path, 'path', 2000), title: req(args.title, 'title', 140), summary: str(args.summary, 1000) }, o);
      const page = pageOf(o.taskId);
      if (page) {
        return page.file_id === entry.id
          ? `Delivered "${entry.title}" (file ${entry.id}). It is now the current version of the page "${page.title}".`
          : `Delivered "${entry.title}" (file ${entry.id}), but it is not the same kind of file as the page "${page.title}", so the page still shows its previous version.`;
      }
      return backgroundTask(o.taskId)
        ? `Delivered "${entry.title}" (file ${entry.id}). It is in the Make tab now and goes on this task's handover card when you finish.`
        : `Delivered "${entry.title}" (file ${entry.id}). The user sees it in the thread and the Make tab.`;
    }
    case 'start_task': {
      liveChannel(o.channelId);
      const t = startTask(
        req(args.title, 'title', 120),
        req(args.instructions, 'instructions', 20_000),
        Array.isArray(args.steps) ? args.steps.map((s) => str(s, 200)) : [],
        undefined,
        o.channelId,
      );
      return `Started background task ${t.id} ("${t.title}"). It's in the user's Tasks tab. Tell them in one line, then end your turn. When it finishes, the user gets a handover card in the thread, and a note with its result reaches you with their next message.`;
    }
    case 'save_page':
      return savePage(args, o.taskId);
    case 'save_routine': {
      const saved = saveRoutine(args);
      const at = saved.next_run
        ? new Date(saved.next_run).toLocaleString('en-US', { timeZone: settings.get().timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '—';
      return `Saved routine ${saved.id} ("${saved.title}"): ${scheduleLabel(saved.schedule)}, next ${at}. Each run starts a background task in its own session with a handover card, so the instructions must be self-contained.`;
    }
    case 'remove_routine': {
      const id = req(args.routine_id, 'routine_id', 64);
      return removeRoutine(id) ? `Routine ${id} removed.` : `No routine ${id}.`;
    }
    case 'update_task': {
      const id = req(args.task_id, 'task_id', 64);
      const t = tasks.get(id);
      if (!t) throw new Error(`no task ${id}`);
      if (t.status === 'cancelled') return 'This task was cancelled by the user. Stop working on it and end your turn.';
      const next: Task = { ...t };
      if (args.progress !== undefined) next.progress = str(args.progress, 300);
      if (Array.isArray(args.steps)) next.steps = args.steps.slice(0, 60).map((s: any): TaskStep => ({ text: str(s?.text ?? s, 200), done: !!s?.done }));
      if (args.result !== undefined) next.result = str(args.result, 2000);
      // Provenance for the result: an unknown local id fails the call rather
      // than handing over a citation that opens nothing.
      const taskSources = parseSources(args.sources, sourceExists);
      if (taskSources !== undefined) next.sources = taskSources;
      if (args.changed !== undefined) next.changed = str(args.changed, 300);
      if (args.follow_ups !== undefined) next.follow_ups = followUps(args.follow_ups);
      if (typeof args.status === 'string' && ['running', 'waiting', 'done', 'failed'].includes(args.status)) next.status = args.status as Task['status'];
      // The agent saying done only ever "looks done": the user's own confirm is the real completion, and the first
      // finish is the one that counts, so a later update can't move the stamp.
      putTask(withAgentDone(next));
      return `Task ${id} updated.`;
    }
    case 'notify': {
      const refused = notifyRefusal(o.run?.spec.kind);
      if (refused) return refused;
      const noteTitle = req(args.title, 'title', 80);
      const noteBody = str(args.body, 300);
      // A notification is outward-facing text too: secrets never leave through it either. Scan the title as well;
      // it is short, but it is rendered on the lock screen just like the body.
      const secret = [noteTitle, noteBody].flatMap((s) => scanOutbound(s)).find((f) => f.tier === 'never_share');
      if (secret) {
        throw new Error(
          `Notification blocked: the text looks like it contains ${secret.label} (${secret.redacted}). Remove the secret and post again without it — never paste the full value.`,
        );
      }
      // The push names a card, so tapping it lands on something, a dismissed banner isn't the only record, and
      // quiet hours hold it for "While you were away" instead of dropping it.
      const item = postCard({ type: 'note', title: noteTitle, body: noteBody || undefined, status: 'info', alert: true }, o);
      const sent = await notify({ title: item.card!.title, body: item.card!.body ?? '', card_id: item.id, tag: item.id, url: cardUrl(item.id, o.channelId), category: 'agent', channel_id: o.channelId });
      if (sent) return `Notification sent. It is also card ${item.id} in the thread.`;
      return inQuietHours(settings.get())
        ? `Card ${item.id} is in the thread. Quiet hours are on, so the push is held until they end.`
        : `Card ${item.id} is in the thread. No push went out (the app is open on their device, or no device has notifications on).`;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
