# Deploying Hermes Duet

Hermes Duet is one Bun process with a SQLite file and a built React app. It runs the same way on a Mac, an Ubuntu
homelab box, a VPS, or in a container; the only platform-specific parts are the native connectors (macOS only) and
the live browser (any Chromium).

The intended always-on host is a small Linux machine that stays on: a mini-PC, a NAS or a VPS. A Mac works too, but
only while it is awake — see [Always-on host](#always-on-host) for what that does and does not buy you.

Everything that matters lives in `DUET_DATA_DIR` (default `./data`):

| Path | What it is |
|---|---|
| `duet.db` (+ WAL) | items, channels, tasks, files, pages, devices, triggers, settings |
| `files/<id>/` | deliverables the agent produced |
| `uploads/` | photos, PDFs and voice memos you sent |
| `tts/` | synthesized brief audio, cached |
| `internal.token` | loopback token the MCP shim and CLI use |

Back that directory up and you have everything. On POSIX hosts the directory is `0700` and the database and token
files are `0600`; on Windows they rely on your user profile's NTFS ACLs rather than POSIX mode bits.

## Always-on host

A Linux mini-PC, NAS or VPS is the intended always-on host: it runs the server under systemd, stays reachable over
Tailscale, and keeps its data on a disk that is actually attached to it. Everything below also applies to a Mac
that is left awake, with the caveat in [What "always-on" does not mean](#what-always-on-does-not-mean).

### systemd unit

```sh
sudo apt install -y unzip curl
curl -fsSL https://bun.sh/install | bash
bun install && bun run build
hermes-duet install-systemd   # ~/.config/systemd/user/hermes-duet.service
loginctl enable-linger "$USER"   # keep it running with no login session
hermes-duet doctor
```

The unit runs `bun server/index.ts` from the checkout, so build the PWA once (`bun install && bun run build`) and
`install-systemd` handles the rest. `hermes-duet doctor`, `pair`, `say`, `brief` and `checkin` work the same as on
macOS. The connectors section reports Calendar, Reminders and Mail as unsupported on Linux; the agent can still use
any CLI it finds on `PATH` and any MCP server Hermes has configured.

### Private access with Tailscale

```sh
tailscale up
tailscale serve --bg --https=8443 http://127.0.0.1:7456
echo "DUET_PUBLIC_URL=https://<host>.<tailnet>.ts.net:8443" >> .env
hermes-duet restart
```

The doctor checks that `tailscale serve` points at the Duet port. `DUET_PUBLIC_URL` is also what iOS push needs.
Keep port 7456 tailnet-only: the internal listener on 7457 is loopback-only and is never published.

### Where the data lives

`DUET_DATA_DIR` holds the database, uploads, delivered files, the TTS cache and the internal token. Under systemd
the default is `<checkout>/data`, so set it explicitly to a persistent path:

```sh
echo "DUET_DATA_DIR=/srv/hermes-duet/data" >> .env
hermes-duet restart
```

Keep the SQLite file on local disk. SQLite over NFS/SMB is not safe (locking and atomicity are not what those
protocols guarantee), so a NAS mount is fine for `uploads/` and `files/` but is a poor home for `duet.db`.

### Backups and restore

The data directory is the backup unit. Stop the service first for a clean copy (the paths below use the
`/srv/hermes-duet/data` example from above):

```sh
hermes-duet stop
tar czf "hermes-duet-$(date +%F).tgz" -C /srv/hermes-duet/data .
hermes-duet start
```

If `sqlite3` is installed, a hot copy is safe while the server runs (the database is in WAL mode, so copying only
`duet.db` can miss the newest writes in `duet.db-wal`):

```sh
sqlite3 /srv/hermes-duet/data/duet.db ".backup '/srv/hermes-duet/backups/duet-$(date +%F).db'"
rsync -a /srv/hermes-duet/data/uploads/ /srv/hermes-duet/backups/uploads/
```

Restore by stopping the service, replacing the directory, and starting it again. Duet also copies the old database
to `data/backups/duet-v<version>-<timestamp>.db` (three most recent) before a schema migration, which is the
recovery path for a bad upgrade.

### Upgrades

```sh
git pull
bun install && bun run build
hermes-duet restart
hermes-duet doctor
```

### Docker

The image is self-contained: Bun, the built PWA, and Chromium for the live browser pane; `tini` reaps the Chromium
child so the container stops cleanly.

```sh
docker build -t hermes-duet .
docker run -d --name hermes-duet \
  -p 7456:7456 \
  -v hermes-duet-data:/data \
  --env-file .env \
  --restart unless-stopped \
  hermes-duet
docker exec hermes-duet bin/hermes-duet pair   # bash CLI; don't run it with `bun`
```

- **Data volume.** `/data` is the `DUET_DATA_DIR` (set in the image), so `duet.db`, uploads, delivered files and the
  internal token all live on the named volume `hermes-duet-data`. Back up that volume, not the container. A bind
  mount (`-v /srv/hermes-duet/data:/data`) is easier to archive with the same stop-and-copy recipe above.
- **Env file & pairing.** `--env-file .env` supplies `DUET_PUBLIC_URL`, `DUET_HERMES_URL`, `DUET_HERMES_KEY` and
  friends. The image already sets `DUET_HOST=0.0.0.0`, `DUET_PORT=7456`, `DUET_INTERNAL_PORT=7457` and
  `DUET_DATA_DIR=/data`. `bin/hermes-duet pair` reads `DUET_PUBLIC_URL` directly from the container environment (no
  `.env` file is copied into `/app`), and `bin/hermes-duet doctor` recognizes container runtimes without expecting
  `launchd` or `systemd`.
- **Reaching Hermes on the host.** Inside a container, `127.0.0.1:8642` is the container itself, not the host's Hermes
  gateway. Set `DUET_HERMES_URL=http://host.docker.internal:8642`; on Linux Docker Engine also add
  `--add-host=host.docker.internal:host-gateway` (or `extra_hosts` in `docker-compose.yml`).
- **The browser is inside the container.** The image sets `DUET_CHROME_BIN=/usr/bin/chromium` and
  `DUET_CHROME_PROFILE=/data/chrome`, so the agent's Chromium runs in the container with its profile on the data
  volume. The host's browser profile is never the agent's surface, and CDP (port 9333) never leaves the container:
  the phone's pane connects to the app on 7456 and the server proxies frames and input. Pass `--shm-size=256m` (already
  set in `docker-compose.example.yml`) so Chromium does not crash on Docker's default 64 MB `/dev/shm`. If an
  unprivileged container seccomp profile blocks Chromium's sandbox and you cannot pass `--cap-add=SYS_ADMIN`, set
  `DUET_CHROME_NO_SANDBOX=1`.
- **Connectors.** Chromium and the PWA work in the container. The native Calendar, Reminders and Mail connectors
  are macOS-only and report unsupported on Linux; the agent still has CLI tools on `PATH` and Hermes's MCP servers.
- **Ports.** Publish only 7456, and keep it tailnet-only: put Tailscale, a Cloudflare Tunnel or a reverse proxy with
  real auth in front, and do not expose it to the internet. The internal listener on 7457 is loopback-only inside the
  container and must not be exposed. The healthcheck hits `/api/health`, which needs no pairing.

### docker-compose (optional)

[`docker-compose.example.yml`](docker-compose.example.yml) is a labelled starting point, not a required install
path: copy it to `docker-compose.yml`, edit the `.env` path and the Tailscale URL, then `docker compose up -d`. It
uses the same volume, env file and restart policy, and publishes only 7456.

### What "always-on" does not mean

- **Wake-on-LAN is not always-on.** A sleeping machine cannot run a brief, a check-in, a folder trigger or a
  webhook. WOL can wake it for interactive use, but it is not a substitute for a host that stays on.
- **A laptop lid or sleep stops runs.** Scheduled briefs, check-ins, the watched folder, meeting prep, webhook
  delivery and background tasks all run on the host; when the host sleeps, they wait. Keep the lid open, or use a
  mini-PC/NAS/VPS.
- **One Hermes gateway per install.** Duet talks to a single `DUET_HERMES_URL`. Multi-gateway, multi-agent or
  per-profile agent selection is not implemented; the parity document lists it as future work.
- **One host per install.** The database is a single SQLite file, so two hosts running against the same data
  directory is not supported.

## macOS (launchd)

```sh
bun install && bun run build
hermes-duet install          # ~/Library/LaunchAgents/dev.hermes-duet.server.plist
hermes-duet pair             # code for your phone
hermes-duet doctor
```

Expose it privately with `tailscale serve --bg 7456` (the doctor checks this), then open the URL on the phone and pair.
Set `DUET_PUBLIC_URL` to that URL: iOS push needs it.

A Mac is only always-on while it is awake and not lid-closed; when it sleeps, scheduled work waits until it wakes.
The always-on host above is the way to avoid that.

## Windows

Duet runs natively on Windows via Bun (`bun install && bun run build && bun server/index.ts`). File permissions use your
Windows profile's NTFS ACLs instead of POSIX `0700`/`0600` modes, and the macOS Calendar/Reminders/Mail connectors report
unsupported. The live browser probes standard Chrome and Edge installation paths (or honors `DUET_CHROME_BIN`), and the
`bin/hermes-duet` bash CLI works under Git Bash (`C:\Program Files\Git\bin\bash.exe`).

## Logs

The service appends stdout and stderr to `$DUET_LOG_DIR/server.log` (default `~/Library/Logs/hermes-duet` on macOS, or
`${XDG_STATE_HOME:-$HOME/.local/state}/hermes-duet` on Linux) under launchd and the `systemd --user` unit.
`hermes-duet install-systemd` passes `DUET_LOG_DIR` into the unit automatically; if you override `DUET_LOG_DIR`, pick a
directory writable by your user rather than `/var/log`. Duet
does not rotate that file behind your back: a rename would leave the running service writing to the old inode while
`hermes-duet logs` tails an empty new file. Rotate it with:

```sh
hermes-duet rotate-logs        # copytruncate, keep 5 generations
hermes-duet rotate-logs 10     # keep 10
```

It copies `server.log` to `server.log.1`, shifts older generations, and truncates the live file in place, so the
service keeps its descriptor. `hermes-duet doctor` warns once the log passes 50 MB. A weekly cron entry is enough
for a personal install:

```cron
0 3 * * 0 $HOME/.local/bin/hermes-duet rotate-logs 5
```

On systemd the unit writes the file above (in `~/.local/state/hermes-duet/server.log` by default); `hermes-duet logs`
reads `journalctl --user -u hermes-duet`, so `tail -f "${DUET_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hermes-duet}/server.log"`
shows the file log directly.

## Environment

Everything is optional except the Hermes key, which the server can also read from `~/.hermes/.env`.

| Variable | Default | What it does |
|---|---|---|
| `DUET_PORT` | `7456` | public listener (the tunnel points here) |
| `DUET_INTERNAL_PORT` | `7457` | loopback listener for the MCP shim and CLI |
| `DUET_HOST` | `127.0.0.1` | bind address; `0.0.0.0` only inside a container or a firewall |
| `DUET_PUBLIC_URL` | – | the URL the phone uses (needed for iOS push) |
| `DUET_HERMES_URL` | `http://127.0.0.1:8642` | Hermes gateway |
| `DUET_HERMES_KEY` / `API_SERVER_KEY` | – | Hermes API key |
| `DUET_DATA_DIR` | `./data` | database, uploads, deliverables |
| `DUET_LOG_DIR` | `~/Library/Logs/hermes-duet` (macOS), `${XDG_STATE_HOME:-~/.local/state}/hermes-duet` (Linux) | service log directory (launchd/systemd) |
| `DUET_MAX_TRANSACTION_LIMIT` | `500` | **dollars** per `request_payment` |
| `DUET_MAX_TRANSACTION_LIMIT_CENTS` | – | exact cents, overrides the above |
| `DUET_CARD_PROVIDER` | `privacy` | `privacy`, `stripe`, `revolut` or `generic` |
| `DUET_CARD_KEY` | – | provider API key; without it, approval is a spend authorization with no virtual card |
| `DUET_CARD_URL` | provider default | API base (required for `generic`) |
| `DUET_STT_URL` / `DUET_STT_MODEL` / `DUET_STT_KEY` | – | OpenAI-compatible `/audio/transcriptions` |
| `DUET_STT_CMD` | auto (`whisper-cli`) | local transcription command template, `{file}` |
| `DUET_TTS_URL` / `DUET_TTS_MODEL` / `DUET_TTS_VOICE` / `DUET_TTS_KEY` | – | OpenAI-compatible speech endpoint |
| `DUET_TTS_CMD` | `say` on macOS | TTS command template, `{text}` and `{out}` |
| `DUET_TTS_EXT` | `.wav` | extension of what `DUET_TTS_CMD` writes |
| `DUET_WATCH_DIR` | `~/Downloads` | folder watched for receipts and statements |
| `DUET_WATCH_DOWNLOADS` | on | `0` turns the folder watcher off |
| `DUET_MEETING_LEAD_MIN` | `15` | how early a meeting triggers prep (0 disables) |
| `DUET_OP_CMD` | `op item get {domain} --format json` | 1Password lookup |
| `DUET_BW_CMD` | `bw get item {domain} --raw` | Bitwarden lookup (`BW_SESSION` must be set) |
| `DUET_CHROME_BIN` | auto-probed Chrome/Chromium/Edge | Chromium binary for the live browser |
| `DUET_CHROME_NO_SANDBOX` | off | `1` passes `--no-sandbox` for restricted containers |
| `DUET_CHROME_PORT` / `DUET_CHROME_PROFILE` | `9333` / `~/.hermes/duet-chrome` | CDP port, browser profile |
| `DUET_RUN_TIMEOUT_MS` | 45 min | a run silent this long is stopped as hung |
| `DUET_MAX_BACKGROUND` | `2` | background tasks allowed at once |

## Speech, locally

Transcription and the spoken brief are local by default and degrade honestly: with no engine, `/api/audio/transcribe`
returns a message naming what to install.

```sh
brew install whisper-cpp
# point at any ggml model, e.g. base.en
echo 'DUET_STT_CMD=whisper-cli -m ~/models/ggml-base.en.bin -f {file} -nt -np' >> .env
```

On Linux, `piper` is a good TTS:

```sh
echo 'DUET_TTS_CMD=piper --model ~/models/en_US-lessac-medium.onnx --output_file {out}' >> .env
echo 'DUET_TTS_EXT=.wav' >> .env
```

macOS needs nothing: `say` plus `afconvert` (both built in) produce an AAC clip Safari and Chrome both play.
