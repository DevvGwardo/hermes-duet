# Sticky Wall

A quick-capture idea wall inside the DeepSeek Harness Web UI.

- **Left sidebar entry** — a sticky-note icon sits in the sidebar's global panel
  list, so the wall is one click away from anywhere in the app.
- **Wall panel** — an always-ready composer at the top (focused on open,
  `⌘/Ctrl + Enter` to add), then sticky notes laid out in a responsive grid.
- **Note actions** — click a note to edit it, pin important notes to the top,
  delete with an undo bar, search across every note, and pick a paper color.
- **Persistence** — notes are stored in the browser's `localStorage`
  (`dsh.stickyWall.notes.v1`), so they survive reloads and app restarts on the
  same browser profile.

## Composition

| File | Role |
| --- | --- |
| `cordis.patch.yml` | Inserts the `sticky-wall` plugin row. |
| `index.js` | Host half: activates the row; the capability lives in the page. |
| `client.js` | Web half: registers the sidebar entry (`sidebar.panellist`) and the panel (`main` key `sticky-wall`). |
| `locale/en.json` | Plugin Manager title and description. |
| `icon.svg` | Original artwork used in the plugin inventory. |

Styling uses only `--dsw-alias-*` theme tokens (paper tints are mixed from the
notes' accent over `--dsw-alias-bg-layer-1`), so the wall follows light and
dark themes. All visible text comes from the Client locale service
(`sticky-wall` namespace).

## Install

```text
plugin_manager install_bundle  target=/absolute/path/to/sticky-wall
```

The bundle installs as `@local/sticky-wall`. Notes are per browser profile.
