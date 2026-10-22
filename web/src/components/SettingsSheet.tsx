import { useState } from 'react';
import type { Settings } from '../../../shared/types';
import { api, enablePush, isStandalone, pushSupported } from '../api';
import { useStore } from '../store';
import { Icon } from '../ui';
import { WhatICanSee } from './WhatICanSee';

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const pushEnabled = useStore((s) => s.pushEnabled);
  const agent = useStore((s) => s.agent);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [briefMsg, setBriefMsg] = useState<string | null>(null);

  if (!settings) return null;
  const save = (patch: Partial<Settings>) => api.saveSettings(patch).catch(() => {});

  async function onPush() {
    if (!pushSupported()) {
      setPushMsg(isStandalone() ? 'This browser does not support push.' : 'On iPhone: Share → Add to Home Screen, then open Hermes Duet from there.');
      return;
    }
    const r = await enablePush().catch((e) => (setPushMsg(e.message), null));
    if (r === 'denied') setPushMsg('Notifications are blocked. Allow them in Settings → Notifications → Hermes Duet.');
    if (r === 'ok') setPushMsg('Notifications on.');
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>Settings</strong>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="settings-body">
          <section>
            <h3>Notifications</h3>
            <div className="setting-row">
              <span>{pushEnabled ? 'On for this device' : 'Off for this device'}</span>
              {pushEnabled ? (
                <button className="btn btn-ghost small" onClick={() => api.testPush().then((r) => setPushMsg(r.sent ? 'Sent a test.' : 'No devices subscribed.'))}>
                  Send test
                </button>
              ) : (
                <button className="btn btn-primary small" onClick={onPush}>
                  Turn on
                </button>
              )}
            </div>
            {pushMsg && <p className="muted small">{pushMsg}</p>}
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
            <label className="setting-row">
              <span>Quiet from</span>
              <span className="time-pair">
                <input type="time" value={settings.quiet_start} onChange={(e) => save({ quiet_start: e.target.value })} />
                <span className="muted">to</span>
                <input type="time" value={settings.quiet_end} onChange={(e) => save({ quiet_end: e.target.value })} />
              </span>
            </label>
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

          <section>
            <h3>What I can see</h3>
            <p className="muted small">Loaded before your first message, every turn.</p>
            <WhatICanSee />
          </section>
        </div>
      </div>
    </div>
  );
}
