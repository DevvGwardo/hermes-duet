import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { cardOf, isSettledAsk } from '../../shared/links';
import { api, clearSettledNotifications, connect, isStandalone, openChannel, pushSupported } from './api';
import { isIOS } from './platform';
import { ChannelsStrip, ChannelBar, ChannelsSheet, SearchOverlay } from './components/Channels';
import { Composer, type ComposerHandle } from './components/Composer';
import { trackDialogOpeners } from './hooks/useDialogTrap';
import { BrandBadge, Decode, MangaBackdrop, Mascot, SpeechBubble, Wordmark } from './components/Manga';
import { Rail } from './components/Rail';
import { Thread } from './components/Thread';
import { channelItems, getState, useStore } from './store';
import { Icon } from './ui';

// The first paint is the thread. The two other tabs and the three on-demand overlays are their own chunks: a phone
// that only reads chat never downloads the live pane, the settings sheet or the viewer.
const TasksView = lazy(() => import('./components/TasksView').then((m) => ({ default: m.TasksView })));
const MakeView = lazy(() => import('./components/MakeView').then((m) => ({ default: m.MakeView })));
const Viewer = lazy(() => import('./components/Viewer').then((m) => ({ default: m.Viewer })));
const SettingsSheet = lazy(() => import('./components/SettingsSheet').then((m) => ({ default: m.SettingsSheet })));
const BrowserView = lazy(() => import('./components/BrowserView').then((m) => ({ default: m.BrowserView })));

type Tab = 'chat' | 'tasks' | 'make';

const TAB_META: Record<Tab, { label: string; icon: (p: { size?: number }) => React.ReactElement; blurb: string }> = {
  chat: { label: 'Chat', icon: Icon.chat, blurb: 'One thread, everything in it' },
  tasks: { label: 'Tasks', icon: Icon.tasks, blurb: 'What’s running, what needs you' },
  make: { label: 'Make', icon: Icon.make, blurb: 'Docs, decks, dashboards' },
};

export function App() {
  const authed = useStore((s) => s.authed);
  const ready = useStore((s) => s.ready);

  useEffect(() => {
    connect();
  }, []);

  useEffect(() => trackDialogOpeners(), []);

  if (authed === false) return <Pair />;
  if (!ready)
    return (
      <div className="boot">
        <MangaBackdrop stirred />
        <Mascot size={150} live />
      </div>
    );
  return <Shell />;
}

function useStatus() {
  const agent = useStore((s) => s.agent);
  const connected = useStore((s) => s.connected);
  if (!connected) return { cls: 'off', text: 'Reconnecting', short: 'Retrying' };
  if (agent.hermes === 'down') return { cls: 'warn', text: 'Hermes offline', short: 'Offline' };
  if (agent.busy) return { cls: 'busy', text: agent.current_run?.kind === 'brief' ? 'Writing your brief' : 'Working', short: 'Working' };
  if (agent.background_running) return { cls: 'busy', text: `${agent.background_running} in background`, short: `${agent.background_running} running` };
  return { cls: 'idle', text: 'Ready', short: 'Ready' };
}

function channelOf(p: { channel_id?: string | null; url?: string | null }): string | null {
  if (p.channel_id) return p.channel_id;
  if (!p.url) return null;
  try {
    return new URL(p.url, location.origin).searchParams.get('channel') || null;
  } catch {
    return p.url.match(/[?&]channel=([^&#]+)/)?.[1] ?? null;
  }
}

function Shell() {
  const [tab, setTab] = useState<Tab>('chat');
  const [fileId, setFileId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [search, setSearch] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [jump, setJump] = useState<string | null>(null);
  const [briefNote, setBriefNote] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const composer = useRef<ComposerHandle>(null);
  const jumpSeq = useRef(0);
  const agent = useStore((s) => s.agent);
  const pushEnabled = useStore((s) => s.pushEnabled);
  const pending = useStore((s) => s.pending.length);
  const working = useStore((s) => s.tasks.filter((t) => t.status === 'running' || t.status === 'waiting' || t.status === 'queued').length);
  // A string, so streaming deltas don't re-run the effect below; it changes only when another ask is settled.
  const settled = useStore((s) => s.items.filter(isSettledAsk).map((i) => i.id).join(' '));
  const [hideInstall, setHideInstall] = useState(() => localStorageGet('duet.hideInstall') === '1');
  const status = useStatus();
  const stirred = agent.busy || agent.background_running > 0;

  useEffect(() => {
    // Home-screen icon badge = things waiting on you (installed PWAs on iOS 16.4+, Chrome, Edge).
    const nav = navigator as any;
    (pending ? nav.setAppBadge?.(pending) : nav.clearAppBadge?.())?.catch?.(() => {});
  }, [pending]);

  useEffect(() => {
    // An approval or question decided here, on another device, or expired takes its banner with it.
    clearSettledNotifications().catch(() => {});
  }, [settled]);

  useEffect(() => {
    if (tab !== 'tasks' && taskId) setTaskId(null);
  }, [tab, taskId]);

  const jumpTo = async (id: string, channelHint?: string | null) => {
    const seq = ++jumpSeq.current;
    setTab('chat');
    // Resolve which channel the item belongs to first (caller hint, loaded store, or server GET /api/items/:id),
    // then ensure that channel is open and loaded BEFORE asking Thread to scroll to `id`.
    const s = getState();
    let channel =
      channelHint ||
      s.items.find((i) => i.id === id)?.channel_id ||
      s.pending.find((i) => i.id === id)?.channel_id ||
      null;
    if (!channel) {
      try {
        const res = await api.item(id);
        channel = res.item.channel_id ?? getState().channels[0]?.id ?? null;
      } catch {
        channel = getState().channels[0]?.id ?? null;
      }
    }
    if (seq !== jumpSeq.current) return;
    if (channel && (channel !== getState().channelId || channelItems(getState()).length === 0)) {
      await openChannel(channel).catch(() => {});
    }
    if (seq !== jumpSeq.current) return;
    setJump(null);
    requestAnimationFrame(() => {
      if (seq === jumpSeq.current) setJump(id);
    });
  };
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;

  useEffect(() => {
    // Notification taps arrive here when the app is already open. Read both top-level data fields and URL query params.
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open') {
        const card = cardOf(e.data);
        const channel = channelOf(e.data);
        if (card) {
          void jumpToRef.current(card, channel);
        } else if (channel) {
          setTab('chat');
          void openChannel(channel).catch(() => {});
        } else {
          setTab('chat');
        }
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    const card = cardOf({ url: location.search });
    const channel = channelOf({ url: location.search });
    if (card || channel) {
      if (card) void jumpToRef.current(card, channel);
      else if (channel) void openChannel(channel).catch(() => {});
      // A reload shouldn't jump back to the card the notification opened.
      history.replaceState(null, '', location.pathname);
    }
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    // "/" jumps to the composer, ⌘K / Ctrl-K opens search, when no dialog/sheet/overlay is open and focus isn't typing.
    const onKey = (e: KeyboardEvent) => {
      const dialogOpen =
        !!fileId || settings || search || channelsOpen || browserOpen || !!document.querySelector('.sheet, .browser-pane');
      if (dialogOpen) return;
      if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        setSearch(true);
        return;
      }
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      setTab('chat');
      requestAnimationFrame(() => composer.current?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings, fileId, search, channelsOpen, browserOpen]);
  const startPrompt = (p: string) => {
    setTab('chat');
    requestAnimationFrame(() => composer.current?.prefill(p));
  };
  const openFile = (id: string) => {
    setCompareId(null);
    setFileId(id);
  };
  const compareFile = (current: string, previous: string) => {
    setFileId(current);
    setCompareId(previous);
  };
  const briefNow = () =>
    api.runBrief().then(
      () => {
        setBriefNote('Brief on its way');
        setTimeout(() => setBriefNote(null), 4000);
      },
      () => setBriefNote('Could not start a brief'),
    );

  const showInstall = !hideInstall && !isStandalone() && isIOS(navigator);
  const showPushNudge = !showInstall && !pushEnabled && pushSupported() && isStandalone();
  const badges: Record<Tab, number> = { chat: pending, tasks: working, make: 0 };
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className={`app view-${tab}`}>
      <MangaBackdrop stirred={stirred} />

      <aside className="sidebar">
        <div className="side-brand">
          <BrandBadge size={46} live={stirred} />
          <div>
            <Wordmark stacked />
            <div className="brand-sub">your agent, in duet</div>
          </div>
        </div>
        <nav className="side-nav" role="tablist">
          {(Object.keys(TAB_META) as Tab[]).map((t) => {
            const M = TAB_META[t];
            return (
              <button key={t} role="tab" aria-selected={tab === t} className={`side-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                <M.icon size={19} />
                <span className="side-tab-label">{M.label}</span>
                {badges[t] > 0 && <span className={`count ${t === 'chat' ? 'warm' : ''}`}>{badges[t]}</span>}
              </button>
            );
          })}
        </nav>
        <button className="side-action" onClick={briefNow}>
          <Icon.sun size={18} />
          <span>{briefNote ?? 'Brief me now'}</span>
        </button>
        <div className="side-foot">
          <div className={`status-card status-${status.cls}`}>
            <span className="sonar">
              <i />
            </span>
            <div>
              <div className="status-title">{status.text}</div>
              <div className="status-sub">Hermes · {agent.hermes === 'ok' ? 'connected' : agent.hermes}</div>
            </div>
          </div>
          <button className="side-tab" onClick={() => setBrowserOpen(true)}>
            <Icon.globe size={19} />
            <span className="side-tab-label">Live browser</span>
          </button>
          <button className="side-tab" onClick={() => setSettings(true)}>
            <Icon.gear size={19} />
            <span className="side-tab-label">Settings</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="top-brand">
            <BrandBadge size={32} live={stirred} />
            <Wordmark size="sm" />
          </div>
          <div className="top-title">
            <h1>{TAB_META[tab].label}</h1>
            <span className="top-sub">{tab === 'chat' ? today : TAB_META[tab].blurb}</span>
          </div>
          <div className={`status-pill status-${status.cls}`}>
            <span className="status-dot" />
            <span className="status-text">{status.short}</span>
          </div>
          <button className="icon-btn top-gear" onClick={() => setSearch(true)} aria-label="Search everything">
            <Icon.search size={20} />
          </button>
          <button className="icon-btn top-gear" onClick={() => setBrowserOpen(true)} aria-label="Live browser">
            <Icon.globe size={20} />
          </button>
          <button className="icon-btn top-gear" onClick={() => setSettings(true)} aria-label="Settings">
            <Icon.gear size={20} />
          </button>
        </header>

        {showInstall && (
          <div className="banner">
            <span>Add Hermes Duet to your Home Screen (Share → Add to Home Screen) to get notifications.</span>
            <button
              className="icon-btn"
              aria-label="Dismiss"
              onClick={() => {
                localStorageSet('duet.hideInstall', '1');
                setHideInstall(true);
              }}
            >
              <Icon.close size={16} />
            </button>
          </div>
        )}
        {showPushNudge && (
          <button className="banner action" onClick={() => setSettings(true)}>
            Turn on notifications so I can reach you when something needs you.
          </button>
        )}

        <main className="content">
          {tab === 'chat' && (
            <>
              <ChannelsStrip onSearch={() => setSearch(true)} onManage={() => setChannelsOpen(true)} />
              <ChannelBar />
              <Thread onOpenFile={openFile} scrollToId={jump} onSuggest={startPrompt} followKey={sent} onShowTasks={() => setTab('tasks')} />
            </>
          )}
          <Suspense fallback={null}>
            {tab === 'tasks' && <TasksView onJump={jumpTo} onOpenFile={openFile} openTaskId={taskId} onOpenTask={setTaskId} />}
            {tab === 'make' && <MakeView onOpenFile={openFile} onStart={startPrompt} onCompare={compareFile} />}
          </Suspense>
        </main>

        <Composer ref={composer} hidden={tab !== 'chat'} onSent={() => setSent((n) => n + 1)} />

        <nav className="dock" role="tablist">
          {(Object.keys(TAB_META) as Tab[]).map((t) => {
            const M = TAB_META[t];
            return (
              <button key={t} role="tab" aria-selected={tab === t} className={`dock-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                <span className="dock-icon">
                  <M.icon size={21} />
                  {badges[t] > 0 && <span className={`badge ${t === 'chat' ? '' : 'cool'}`}>{badges[t]}</span>}
                </span>
                <span className="dock-label">{M.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <Rail tab={tab} onJump={jumpTo} onOpenFile={openFile} onShowTasks={() => setTab('tasks')} />

      <Suspense fallback={null}>
        {fileId && <Viewer fileId={fileId} compareId={compareId} onClose={() => (setFileId(null), setCompareId(null))} />}
        {channelsOpen && <ChannelsSheet onClose={() => setChannelsOpen(false)} />}
        {search && (
          <SearchOverlay
            onClose={() => setSearch(false)}
            onJump={jumpTo}
            onShowTasks={(id) => {
              setTaskId(id ?? null);
              setTab('tasks');
            }}
            onOpenFile={openFile}
          />
        )}
        {browserOpen && <BrowserView onClose={() => setBrowserOpen(false)} />}
        {settings && <SettingsSheet onClose={() => setSettings(false)} />}
      </Suspense>
    </div>
  );
}

function Pair() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.pair(code.trim());
      await connect();
    } catch (e: any) {
      setErr(e.message === 'not paired' ? 'That code didn’t work. Codes expire after 10 minutes.' : e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pair">
      <MangaBackdrop stirred={busy} />
      <form onSubmit={submit} className="pair-card">
        <div className="pair-hero">
          <Mascot size={210} live={busy} />
          <SpeechBubble>
            Who's this? Run <code>hermes-duet pair</code> on your computer and tell me the code.
          </SpeechBubble>
        </div>
        <h1>
          <Wordmark size="lg" decode />
        </h1>
        <p className="pair-tag">
          <Decode text="your agent, working alongside you" speed={55} delay={1600} loopMs={17000} hold={5} />
        </p>
        <div className="pair-panel">
          <label htmlFor="pair-code">Pairing code</label>
          <input
            id="pair-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-1234"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={12}
            autoFocus
          />
          {err && <p className="error small">{err}</p>}
          <button className="btn btn-primary" disabled={code.trim().length < 6 || busy}>
            {busy ? 'Pairing…' : 'Pair'}
          </button>
        </div>
      </form>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}
