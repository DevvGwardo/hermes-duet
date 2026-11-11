# Blueprint harness

Browser sweep that produces every screenshot and number in the blueprint
(`docs/blueprint/hermes-duet-blueprint.html`). Historic full-green baseline (2026-11-04):
`sweep-974e7af5` / `live-2b399536` — 24/24 and 6/6; all ten scripts 99/99, 37 screenshots, reviewed.
Later local full-suite receipts (see `GAPS.md` §10.2) passed 9 of 10 scripts (`sweep` 24/24, `pairing` 7/7,
`channels` 6/6, `approvals` 7/7, `dialogs` 21/21 on a fresh seed, `a11y` 10/10, `polish` 8/8, `recovery` 4/4,
`wheel` 6/6), while `live.mjs` locally hits 5/6 when `tapRepaintDiff=0` under non-focused/headless Chrome.

Not published as an Artifact. View locally:
`python3 -m http.server 8765 -d docs/blueprint` →
`http://localhost:8765/hermes-duet-blueprint.html`.

It drives the real app in Chrome (Playwright) against a throwaway demo server
with seeded content (`bun scripts/demo.ts --reset`: data in a temp dir,
scheduler off) and writes raw evidence to `blueprint-out/` (gitignored;
override with `BP_OUT=/path`, the app with `APP_URL=...`). Every script uses
`CHROME_PATH` when set (default: Chrome in `/Applications`), so the same suite
runs on Linux and in the nightly `Browser harness` workflow.

Three scripts are local-only and named in the CI workflow: `recovery.mjs` restarts
the server through the blueprint helper; `live.mjs` needs a driven Chrome that
actually paints frames; `wheel.mjs` opens that same pane and waits for its stage.
The CI runner's headless Chromium delivered no frames, so it runs the other seven.

| Script | What it checks and captures |
|---|---|
| `sweep.mjs` | pair screen + real pairing through the UI, chat thread (brief/approval/choice/checklist/metrics/file cards), tasks tab, make tab, viewer modal (sandbox asserted), search overlay (no title-echo rows), settings sheet, live browser pane, 390px phone layout (composer single-line, no sideways scroll), console-error audit |
| `live.mjs` | driven-Chrome reset, pane toolbar, non-black frames, URL-bar navigation to a local fixture, tap→repaint measured in-page |
| `channels.mjs` | create #taxes in the sheet, post, search, jump; general-first strip order |
| `pairing.mjs` | wrong/reused codes, cookie-less 401s, public health (lockout deliberately untested) |
| `a11y.mjs` | `/` focus, tab-walk names/visibility/focus, WCAG contrast from computed styles |
| `approvals.mjs` | approve + answer through the real buttons, decision lines, badge counts (fresh seed) |
| `recovery.mjs` | dead-Hermes status, Reconnecting, restart resync without dupes |
| `dialogs.mjs` | focus trap + opener return in all five dialogs, long-draft height, empty-search contrast guards (self-seeds a long draft) |
| `wheel.mjs` | wheel scroll sends scroll input, fresh pane lists tabs, 5+ tabs at 390px without overflow |

Run it (never in parallel with another sweep; perf numbers skew):

```sh
BP_SKILL=~/.agents/skills/blueprint
bun run build
(prepare the live fixture once: python3 -m http.server 7499 -d tools/blueprint/fixture &)
python3 "$BP_SKILL/scripts/devserver.py" start --url http://127.0.0.1:7466/ \
  --expect "Hermes Duet" --cwd "$PWD" -- env DUET_CHROME_PORT=9334 \
  "DUET_CHROME_PROFILE=$PWD/blueprint-out/chrome-profile" \
  DUET_HERMES_URL=http://127.0.0.1:9 bun scripts/demo.ts --reset
export APP_URL=http://127.0.0.1:7466/ BP_OUT="$PWD/blueprint-out"
for s in sweep live channels pairing a11y approvals recovery; do
  node tools/blueprint/$s.mjs || echo "$s FAILED"
done
python3 "$BP_SKILL/scripts/devserver.py" stop --url http://127.0.0.1:7466/
```

The script prints its fresh `blueprint-out/data/report-sweep-<run>.json` path
({checks, perf, errors, screenshots}) and exits non-zero on any failed check.
Images live under `ui/<run>/`. Read the printed report path, never a stale one.

Then fill the page's counts from exactly those reports (never type a number by hand;
use the run paths the scripts printed, e.g. report-sweep-xxxx.json — never a stale glob):

```sh
python3 "$BP_SKILL/scripts/tally.py" blueprint-out/data/report-<run>.json [...] \
  --fill docs/blueprint/hermes-duet-blueprint.html
```

Harness notes (each learned the hard way):
- Pairing goes through the real UI: the code comes from the loopback-only
  internal API (`POST :7467/internal/pair` with `internal.token`), typed into
  `#pair-code`. The phone pass reuses the desktop context's `duet_device`
  cookie via `addCookies`.
- At desktop width the topbar icon buttons hide via CSS — use the visible
  controls (`.channel-search` on the Chat tab, sidebar `.side-tab` buttons).
- The viewer iframe swallows Escape; close it with its header Close button.
- `innerText` applies CSS `text-transform` and skips input values — match
  headings case-insensitively, read times via `inputValue()`.
- The logged-out pair screen probes `/api/state` and gets the expected 401;
  the sweep allowlists exactly that entry (`No unexpected console errors`).
- The demo server owns no agent-driven Chrome, so the live pane's stage is
  empty by design; frame streaming is roadmap P1, not a passing check.
