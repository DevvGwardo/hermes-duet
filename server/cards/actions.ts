import { askAge } from '../../shared/age';
import type { CardStatus, FileEntry, Item } from '../../shared/types';
import { approvalDecision, approvalPush } from '../approval';
import { BRIEF_RETRY, skipEntry, useAction, useDraft } from '../brief';
import * as browser from '../browser';
import { channels, files, items, settings, tasks } from '../db';
import { useFollowUp } from '../handover';
import { hermes } from '../hermes';
import { cardExpired, issueCard, money, paymentDecision, paymentPrompt, providerFromEnv } from '../payments';
import { decisionPrompt } from '../prompts';
import { enqueue, requeueTask, runBrief, submitSystem, submitUser } from '../runs/manager';
import {
  cardUrl,
  channelForFile,
  confirmTask,
  expireDeadPrompts,
  liveChannel,
  liveChannelId,
  mainSessionId,
  pushSafe,
  put,
  putTask,
  syncRoutineResult,
  systemNote,
} from '../runs/state';
import { postCard } from '../tools/deliver';

/** Plain data only, bounded: a dashboard can send a row id or a filter, not a novel. */
function safePayload(p: unknown): string {
  try {
    return (JSON.stringify(p ?? null) ?? 'null').slice(0, 2000);
  } catch {
    return 'null';
  }
}

/**
 * A button inside a delivered dashboard was pressed. It arrives as a system line naming the file and the action, and
 * starts a turn with the payload, so the agent can update the deliverable or do what the button promised.
 */
export function deliverableAction(file: FileEntry, raw: Record<string, unknown>): Item {
  const action = String(raw.action ?? '')
    .replace(/[^\w.-]/g, '')
    .slice(0, 64);
  if (!action) throw new Error('missing action');
  const path = files.get(file.id)?.path;
  const prompt = `[deliverable ${file.id}] The user pressed "${action}" in the deliverable "${file.title}" (${file.name})${path ? `, which is at ${path}` : ''}.\n\nPayload: ${safePayload(raw.payload)}\n\nDo what the button asks. If that means changing the deliverable, deliver a new version with deliver_file (and update the standing page with save_page + page_id if it is one). Anything outward-facing still goes through request_approval.`;
  return submitSystem(`From “${file.title}”: ${action}`, prompt, channelForFile(file));
}

/**
 * `Duet.requestApproval(...)` from a delivered dashboard. The dashboard is agent-written code, so its request is only
 * ever a *proposal*: it posts a normal approval card, and nothing happens until the user taps it.
 */
export function deliverableApproval(file: FileEntry, raw: Record<string, unknown>): Item {
  const title =
    String(raw.title ?? '')
      .trim()
      .slice(0, 140) || `Approve something from “${file.title}”`;
  const summary =
    String(raw.summary ?? '')
      .trim()
      .slice(0, 4000) || `“${file.title}” is asking for your approval.`;
  const action_label = String(raw.action_label ?? '').trim().slice(0, 30) || undefined;
  const channel = liveChannel(channelForFile(file));
  const item = postCard(
    { type: 'approval', title, body: `${summary}\n\n— from “${file.title}”`, action_label, status: 'pending' },
    { sessionId: channel.session_id, taskId: null, channelId: channel.id },
  );
  pushSafe({ ...approvalPush(item), url: cardUrl(item.id, channel.id), channel_id: channel.id }, { ignoreQuiet: true });
  return item;
}

/** Card ids whose decision is on its way to Hermes right now, so a double-tap can't send it twice. */
const decidingCards = new Set<string>();

/**
 * Forward a decision to Hermes for one of its own ask cards, keeping the card pending until the POST
 * succeeds and deduplicating concurrent taps via `decidingCards`. On failure, reverts to pending with an error.
 */
export async function settleHermesAsk(item: Item, status: CardStatus, send: () => Promise<unknown>): Promise<Item> {
  if (decidingCards.has(item.id)) throw new Error('that decision is already on its way');
  decidingCards.add(item.id);
  try {
    await send();
  } catch (e: any) {
    const latest = items.get(item.id);
    if (latest?.card?.status === 'expired') {
      throw new Error("that request ended with its run, so there's nothing left to answer");
    }
    const card = { ...(latest?.card ?? item.card!) };
    // Nothing was decided, so the card must not carry a decision either.
    delete card.decision;
    delete card.decided_at;
    put({ ...item, card: { ...card, status: 'pending', error: `The agent didn't get that (${e?.message ?? e}). Tap again to retry.` } });
    throw new Error("The agent didn't receive that decision. Tap again to retry.");
  } finally {
    decidingCards.delete(item.id);
  }
  const latest = items.get(item.id);
  if (latest?.card?.status === 'expired') return latest;
  const card = latest?.card ?? item.card!;
  return put({ ...item, card: { ...card, status, error: undefined } });
}

export async function actOnCard(id: string, action: string, value?: string): Promise<Item> {
  const item = items.get(id);
  if (!item || item.kind !== 'card' || !item.card) throw new Error('card not found');
  const c = item.card;
  if (c.type === 'handover' && action === 'retry') return retryTask(item);
  if (c.type === 'handover' && action === 'complete') return completeHandover(item);
  if (c.type === 'brief' && action === 'use_draft') {
    const d = useDraft(c, item.id, value);
    const updated = put({ ...item, card: { ...c, entries: d.entries } });
    submitUser(d.shown, d.prompt, c.channel_id);
    return updated;
  }
  // One-tap chips that send a stored message as the user. The card records the tap, so the chip stays spent.
  if (c.type === 'brief' && action === 'send_action') {
    const d = useAction(c, value);
    const updated = put({ ...item, card: { ...c, entries: d.entries } });
    submitUser(d.message, undefined, c.channel_id);
    return updated;
  }
  // Skipping a decision runs no agent turn: the mark on the card is what later check-ins and briefs read.
  if (c.type === 'brief' && (action === 'skip' || action === 'unskip')) {
    return put({ ...item, card: { ...c, entries: skipEntry(c, value, action === 'unskip') } });
  }
  if (c.type === 'handover' && action === 'follow_up') {
    const d = useFollowUp(c, value);
    submitUser(d.message, undefined, c.channel_id ?? channels.forTask(c.task_id ? tasks.get(c.task_id) : null));
    return put({ ...item, card: { ...c, follow_ups: d.follow_ups } });
  }
  if (c.status !== 'pending') throw new Error(`already ${c.status}`);
  // A card left over from before its run ended (or from before this check existed) must not show as decided.
  if (c.hermes && expireDeadPrompts() && items.get(id)?.card?.status === 'expired') {
    throw new Error("that request ended with its run, so there's nothing left to answer");
  }
  let approved: boolean | undefined;
  let answer: string | undefined;
  let edits: { draft: string; edited: true } | undefined;
  if (c.type === 'approval') {
    const d = approvalDecision(c, action, value);
    approved = d.approved;
    if (d.draft) edits = { draft: d.draft, edited: true };
  } else if (c.type === 'payment') {
    approved = paymentDecision(action).approved;
  } else if (c.type === 'choice') {
    const opts = c.options?.length ? c.options : ['Yes', 'No'];
    if (action !== 'choose' || !value || !opts.includes(value)) throw new Error('invalid choice');
    answer = value;
  } else {
    throw new Error('this card takes no action');
  }

  const decided = c.type === 'approval' || c.type === 'payment';
  const status: CardStatus = decided ? (approved ? 'approved' : 'declined') : 'answered';
  const ask = c.hermes;
  item.card = {
    ...c,
    ...edits,
    // A Hermes-native ask is not decided yet: see settleHermesAsk.
    status: ask ? 'pending' : status,
    decision: answer ?? (approved ? 'approve' : 'decline'),
    decided_at: Date.now(),
  };
  put(item);

  // A payment is settled before the agent hears anything: the answer it gets depends on whether a card could be
  // issued and typed in.
  if (c.type === 'payment') {
    await settlePayment(item, !!approved);
    // settlePayment may have rewritten the card (card summary, filled flag); return what is on disk now.
    return items.get(item.id) ?? item;
  }

  if (ask) {
    await settleHermesAsk(item, status, () =>
      ask.kind === 'approval'
        ? hermes.approve(ask.run_id, ask.request_id, ask.generation, approved ? 'once' : 'deny')
        : hermes.clarify(ask.run_id, ask.request_id, ask.generation, answer!),
    );
    if (c.task_id) {
      const t = tasks.get(c.task_id);
      if (t && t.status === 'waiting') putTask({ ...t, status: 'running', progress: '' });
    }
    return items.get(item.id) ?? item;
  } else if (c.rerun === 'brief') {
    // A fresh brief run, not an agent turn about the old one: it gathers again from now.
    if (answer === BRIEF_RETRY[0]) runBrief('manual');
  } else if (c.resume && answer !== c.options?.[0]) {
    // Leaving interrupted work alone needs no agent turn.
    if (c.task_id) {
      const t = tasks.get(c.task_id);
      if (t && t.status !== 'done') syncRoutineResult(putTask({ ...t, status: 'cancelled', progress: '' }));
    }
  } else {
    const sessionId = c.session_id ?? (c.task_id ? tasks.sessionOf(c.task_id) : null) ?? mainSessionId();
    if (c.task_id) {
      const t = tasks.get(c.task_id);
      if (t && (t.status === 'waiting' || (c.resume && t.status === 'failed'))) putTask({ ...t, status: 'queued', progress: '' });
    }
    // A card answered long after it was posted resumes with a note to check it still holds before acting.
    const age = askAge(item.created_at, Date.now(), settings.get().timezone);
    enqueue({
      kind: c.task_id ? 'task' : 'decision',
      sessionId,
      channelId: liveChannelId(c.channel_id ?? channels.forTask(c.task_id ? tasks.get(c.task_id) : null)),
      taskId: c.task_id ?? null,
      input: decisionPrompt(item, { approved, answer }, age),
    });
  }
  return item;
}

/**
 * Carry out an approved payment. With a provider configured, a single-use card is issued for exactly the approved
 * total and typed into the agent's live browser, but only while the tab is still on the approved merchant's host;
 * the number exists only in this function's locals and is never put on the card, in the database, or in the prompt.
 * The agent's next turn is told what actually happened.
 */
async function settlePayment(item: Item, approved: boolean): Promise<void> {
  const c = item.card!;
  const channel = liveChannelId(c.channel_id ?? channels.forTask(c.task_id ? tasks.get(c.task_id) : null));
  let cardFilled = false;
  let last4: string | undefined;
  let failure: string | undefined;

  if (approved) {
    let provider = null;
    try {
      provider = providerFromEnv(process.env);
    } catch (e: any) {
      failure = e?.message ?? 'the card provider is misconfigured';
    }
    if (provider && !failure) {
      // Cards approved before the merchant binding carry no host to check the tab against, so they can never be
      // filled: issuing one anyway would only create a live card number with nowhere safe to type it.
      const expectedSite = c.merchant_url ?? c.merchant_host;
      if (!expectedSite) {
        failure = 'this payment was approved without a bound merchant site, so no card was typed into the browser. Send a new request_payment from the exact checkout page and have the user approve that instead.';
      } else {
        try {
          const card = await issueCard(provider, { amountCents: c.amount_cents ?? 0, currency: c.currency ?? 'USD', merchant: c.merchant ?? 'the merchant' });
          if (cardExpired(card)) throw new Error('the issued card was already expired');
          last4 = card.last4;
          try {
            const fields = await browser.fillCard(card, expectedSite);
            cardFilled = fields.number && fields.expiry && fields.cvv;
            if (!cardFilled) failure = 'no checkout fields were found in the live browser';
          } catch (e: any) {
            failure = e?.message ?? 'could not fill the card into the browser';
          } finally {
            // Best effort: the number is not kept anywhere after this call.
            card.number = '';
            card.cvv = '';
          }
          item = put({
            ...item,
            card: {
              ...c,
              status: 'approved',
              decision: 'approve',
              card_summary: cardFilled
                ? `single-use ${provider.name} card ending ${last4}, good for one transaction and one hour, filled into the browser`
                : `single-use ${provider.name} card ending ${last4} was issued, but not filled into the browser`,
              card_filled: cardFilled,
            },
          });
        } catch (e: any) {
          failure = e?.message ?? 'the card provider failed';
        }
      }
    }
  }

  if (failure && approved) {
    systemNote(`I can't finish that payment: ${failure}. The approval stands for ${money(c.amount_cents ?? 0, c.currency ?? 'USD')}.`, c.task_id, channel);
  }
  const sessionId = c.session_id ?? (c.task_id ? tasks.sessionOf(c.task_id) : null) ?? mainSessionId();
  const prompt = paymentPrompt(c, item.id, { approved }, { cardFilled, last4 });
  enqueue({
    kind: c.task_id ? 'task' : 'decision',
    sessionId,
    channelId: channel,
    taskId: c.task_id ?? null,
    input: failure && !prompt.includes(failure) ? `${prompt} Note before you continue: ${failure}` : prompt,
  });
}

/**
 * "Try again" on a failed handover card: the same task restarts from its stored instructions in a fresh Hermes
 * session (the old one ended in the failure), and finishing posts a new handover card at the bottom of the thread.
 */
function retryTask(item: Item): Item {
  const c = item.card!;
  const t = c.task_id ? tasks.get(c.task_id) : null;
  if (!c.failed || !t) throw new Error('this card takes no action');
  if (c.decision) throw new Error('already tried again');
  if (t.status !== 'failed' || !t.instructions) throw new Error('this task cannot be restarted');
  const task = requeueTask(t, t.result);
  return put({ ...item, card: { ...c, decision: 'Tried again', decided_at: task.retried_at } });
}

/**
 * "Mark done" on a handover card: the user's own completion, which is the real one. The card refreshes in place to
 * show it, and the task keeps the stamp so the Tasks tab agrees.
 */
function completeHandover(item: Item): Item {
  const c = item.card!;
  const t = c.task_id ? tasks.get(c.task_id) : null;
  if (!t) throw new Error('this card takes no action');
  confirmTask(t.id);
  return items.get(item.id) ?? item;
}
