import { useEffect, useRef, useState } from 'react';
import type { Connector, Settings } from '../../../shared/types';
import { api, enablePush, isStandalone, pushSupported } from '../api';
import { useStore } from '../store';
import { useDialogTrap } from '../hooks/useDialogTrap';
import { Icon } from '../ui';
import { ConnectorsSheet } from './ConnectorsSheet';
import { MemorySheet } from './MemorySheet';
import { RoutinesSheet } from './RoutinesSheet';
import { WhatICanSee } from './WhatICanSee';

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const pushEnabled = useStore((s) => s.pushEnabled);
  const agent = useStore((s) => s.agent);
  const channels = useStore((s) => s.channels);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [maxPushes, setMaxPushes] = useState(() => String(settings?.max_pushes_per_day ?? 0));
  const [briefMsg, setBriefMsg] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [trig, setTrig] = useState<{ webhook_url: string; watch_dir: string | null; meeting_lead_minutes: number; triggers: { id: string; kind: string; last_triggered_at: number | null }[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  // The hard-block policy is informational only; older servers don't serve it, so a failure just hides the section.
  const [policy, setPolicy] = useState<{ id: string; title: string; detail: string }[] | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog, () => {
    if (routinesOpen || showConnectors || memoryOpen) return false;
    onClose();
  });

  useEffect(() => {
    if (settings) setMaxPushes(String(settings.max_pushes_per_day ?? 0));
  }, [settings?.max_pushes_per_day]);

  // Probes run local checks on the host, so they load when the sheet opens rather than with every snapshot.
  useEffect(() => {
    api
      .connectors()
      .then((r) => setConnectors(r.connectors))
      .catch((e) => setConnErr(e?.message ?? 'Could not check connectors.'));
    api.triggers().then(setTrig).catch(() => {});
    api.policy().then((r) => setPolicy(r.blocks)).catch(() => {});
  }, []);

  if (!settings) return null;
  const save = (patch: Partial<Settings>) => {
    setSaveErr(null);
    return api.saveSettings(patch).catch((e: any) => {
      setSaveErr(e?.message ?? 'Could not save settings.');
    });
  };

  function commitMaxPushes() {
    const trimmed = maxPushes.trim();
    const parsed = trimmed === '' ? 0 : Math.trunc(Number(trimmed));
    if (!Number.isFinite(parsed)) {
      setMaxPushes(String(settings?.max_pushes_per_day ?? 0));
      return;
    }
    const clamped = Math.max(0, Math.min(100, parsed));
    setMaxPushes(String(clamped));
    if (clamped !== (settings?.max_pushes_per_day ?? 0)) void save({ max_pushes_per_day: clamped });
  }

  async function onTestPush() {
    setPushBusy(true);
    setPushMsg(null);
    try {
      const r = await api.testPush();
      setPushMsg(r.sent ? 'Sent a test.' : 'No devices subscribed.');
    } catch (e: any) {
      setPushMsg(e?.message ?? 'Could not send a test notification.');
    } finally {
      setPushBusy(false);
    }
  }

  async function testConnector(id: string) {
    setTesting(id);
    setConnErr(null);
    try {
      const { connector } = await api.testConnector(id);
      setConnectors((list) => list?.map((c) => (c.id === id ? connector : c)) ?? [connector]);
    } catch (e: any) {
      setConnErr(e?.message ?? 'That connector did not answer.');
    } finally {
      setTesting(null);
    }
  }

  async function onPush() {
    if (pushBusy) return;
    if (!pushSupported()) {
      setPushMsg(isStandalone() ? 'This browser does not support push.' : 'On iPhone: Share → Add to Home Screen, then open Hermes Duet from there.');
      return;
    }
    setPushBusy(true);
    setPushMsg(null);
    try {
      const r = await enablePush();
      if (r === 'denied') setPushMsg('Notifications are blocked. Allow them in Settings → Notifications → Hermes Duet.');
      if (r === 'ok') setPushMsg('Notifications on.');
    } catch (e: any) {
      setPushMsg(e?.message ?? 'Could not turn on notifications.');
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={dialog} className="sheet settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>Settings</strong>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        {saveErr && (
          <p className="sheet-error" role="alert">
            {saveErr}
          </p>
        )}
        <div className="settings-body">
          <section>
            <h3>Notifications</h3>
            <div className="setting-row">
              <span>{pushEnabled ? 'On for this device' : 'Off for this device'}</span>
              {pushEnabled ? (
                <button className="btn btn-ghost small" disabled={pushBusy} onClick={onTestPush}>
                  {pushBusy ? 'Sending…' : 'Send test'}
                </button>
              ) : (
                <button className="btn btn-primary small" disabled={pushBusy} onClick={onPush}>
                  {pushBusy ? 'Turning on…' : 'Turn on'}
                </button>
              )}
            </div>
            {pushMsg && <p className="muted small">{pushMsg}</p>}
            <label className="setting-row">
              <span>Task pushes</span>
              <select aria-label="Task pushes" value={settings.notify_tasks ?? 'all'} onChange={(e) => save({ notify_tasks: e.target.value as Settings['notify_tasks'] })}>
                <option value="all">Every finish</option>
                <option value="failures">Failures only</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="setting-row">
              <span>Agent notifications</span>
              <input type="checkbox" className="switch" checked={settings.notify_agent ?? true} onChange={(e) => save({ notify_agent: e.target.checked })} />
            </label>
            <label className="setting-row">
              <span>Max pushes a day</span>
              <input
                type="number"
                min={0}
                max={100}
                value={maxPushes}
                onChange={(e) => setMaxPushes(e.target.value)}
                onBlur={commitMaxPushes}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitMaxPushes();
                  }
                }}
              />
            </label>
            <div className="setting-row column">
              <span>Mute a channel</span>
              <div className="mute-list">
                {channels.map((c) => {
                  const muted = (settings.muted_channels ?? []).includes(c.id);
                  return (
                    <label key={c.id} className="mute-row">
                      <input
                        type="checkbox"
                        checked={muted}
                        onChange={(e) =>
                          save({
                            muted_channels: e.target.checked
                              ? [...(settings.muted_channels ?? []), c.id]
                              : (settings.muted_channels ?? []).filter((id) => id !== c.id),
                          })
                        }
                      />
                      <span>#{c.name}</span>
                    </label>
                  );
                })}
                {!channels.length && <span className="muted small">No channels yet.</span>}
              </div>
            </div>
            <p className="muted small">Approvals and questions always reach you. A muted channel still posts in its thread.</p>
          </section>

          <section>
            <h3>Morning brief</h3>
            <label className="setting-row">
              <span>Send a brief each morning</span>
              <input type="checkbox" className="switch" checked={settings.brief_enabled} onChange={(e) => save({ brief_enabled: e.target.checked })} />
            </label>
            <label className="setting-row">
              <span>Time</span>
              <input type="time" value={settings.brief_time} onChange={(e) => save({ brief_time: e.target.value })} />
            </label>
            <div className="setting-row">
              <span>Run one now</span>
              <button
                className="btn btn-ghost small"
                onClick={() => api.runBrief().then(() => setBriefMsg('Working on it. It will land in Chat.'), (e) => setBriefMsg(e.message))}
              >
                Brief me
              </button>
            </div>
            {briefMsg && <p className="muted small">{briefMsg}</p>}
          </section>

          <section>
            <h3>Check-ins</h3>
            <p className="muted small">Between briefs I look for anything new that needs you and stay quiet otherwise. Each check uses model calls.</p>
            <div className="segmented" role="radiogroup">
              {(['off', '3x', 'hourly'] as const).map((v) => (
                <button key={v} role="radio" aria-checked={settings.checkins === v} className={settings.checkins === v ? 'on' : ''} onClick={() => save({ checkins: v })}>
                  {v === 'off' ? 'Off' : v === '3x' ? '3× a day' : 'Hourly'}
                </button>
              ))}
            </div>
            <div className="setting-row" role="group" aria-label="Quiet hours">
              <span>Quiet from</span>
              <span className="time-pair">
                <input type="time" aria-label="Quiet from" value={settings.quiet_start} onChange={(e) => save({ quiet_start: e.target.value })} />
                <span className="muted">to</span>
                <input type="time" aria-label="Quiet to" value={settings.quiet_end} onChange={(e) => save({ quiet_end: e.target.value })} />
              </span>
            </div>
          </section>

          <section>
            <h3>Routines</h3>
            <p className="muted small">Background tasks on a schedule you write in plain language: every Monday at 9, every 6 hours.</p>
            <div className="setting-row">
              <span>Scheduled routines</span>
              <button className="btn btn-ghost small" onClick={() => setRoutinesOpen(true)}>
                Manage
              </button>
            </div>
          </section>

          <section>
            <h3>Connectors</h3>
            <div className="setting-row">
              <span>What is connected, and what to add next</span>
              <button className="btn btn-ghost small" onClick={() => setShowConnectors(true)}>
                Open
              </button>
            </div>
            <p className="muted small">Local tools and apps on this computer. Nothing leaves it: each one runs locally via a CLI or system bridge.</p>
            {connErr && <p className="card-error">{connErr}</p>}
            {!connectors && !connErr && <p className="muted small">Checking…</p>}
            <ul className="connector-list">
              {(connectors ?? []).map((c) => (
                <li key={c.id} className={`connector ${c.status}`}>
                  <span className={`conn-dot ${c.status}`} aria-hidden="true" />
                  <span className="connector-main">
                    <span className="connector-name">{c.name}</span>
                    <span className="connector-detail">{c.detail}</span>
                    {c.status !== 'active' && c.hint && <span className="connector-hint">{c.hint}</span>}
                  </span>
                  <button className="btn btn-ghost small" disabled={testing === c.id} onClick={() => testConnector(c.id)}>
                    {testing === c.id ? 'Checking…' : 'Test'}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>Triggers</h3>
            <p className="muted small">Beyond the clock: things that happen and wake me up. Quiet hours still apply.</p>
            {trig ? (
              <>
                <label className="setting-row column">
                  <span>Webhook URL</span>
                  <span className="hook-row">
                    <input readOnly value={trig.webhook_url} onFocus={(e) => e.target.select()} aria-label="Webhook URL" />
                    <button
                      className="btn btn-ghost small"
                      onClick={() => {
                        navigator.clipboard?.writeText(trig.webhook_url).then(
                          () => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          },
                          () => {},
                        );
                      }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </span>
                </label>
                <div className="setting-row">
                  <span>Watched folder</span>
                  <span className="muted">{trig.watch_dir ?? 'off'}</span>
                </div>
                <div className="setting-row">
                  <span>Meeting heads-up</span>
                  <span className="muted">{trig.meeting_lead_minutes > 0 ? `${trig.meeting_lead_minutes} min before` : 'off'}</span>
                </div>
                <p className="muted small">
                  Point GitHub, Stripe, Zapier or n8n at that URL with a POST, or just <code>curl -X POST</code> it. Add <code>?kind=name</code> to label the event.
                </p>
              </>
            ) : (
              <p className="muted small">Loading…</p>
            )}
          </section>

          <section>
            <h3>Agent</h3>
            <div className="setting-row">
              <span>Hermes</span>
              <span className={`conn-pill ${agent.hermes}`}>{agent.hermes === 'ok' ? 'Connected' : agent.hermes === 'down' ? 'Unreachable' : 'Checking'}</span>
            </div>
            <div className="setting-row">
              <span>Timezone</span>
              <span className="muted">{settings.timezone}</span>
            </div>
          </section>

          {policy && policy.length > 0 && (
            <section>
              <h3>Always refused</h3>
              <p className="muted small">No approval card can authorize these. The agent is told to refuse them outright.</p>
              <ul className="connector-list">
                {policy.map((b) => (
                  <li key={b.id} className="connector">
                    <span className="connector-main">
                      <span className="connector-name">{b.title}</span>
                      <span className="connector-detail">{b.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3>What I can see</h3>
            <p className="muted small">Loaded before your first message, every turn.</p>
            <WhatICanSee />
            <div className="setting-row">
              <span>Memory</span>
              <button className="btn btn-ghost small" onClick={() => setMemoryOpen(true)}>
                Edit
              </button>
            </div>
          </section>
        </div>
      </div>
      {showConnectors && <ConnectorsSheet onClose={() => setShowConnectors(false)} />}
      {routinesOpen && <RoutinesSheet onClose={() => setRoutinesOpen(false)} />}
      {memoryOpen && <MemorySheet onClose={() => setMemoryOpen(false)} />}
    </div>
  );
}
