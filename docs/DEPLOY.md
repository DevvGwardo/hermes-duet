# Deploying Hermes Duet

Hermes Duet is one Bun process with a SQLite file and a built React app. It runs the same way on a Mac, an Ubuntu
homelab box, a VPS, or in a container; the only platform-specific parts are the native connectors (macOS only) and
the live browser (any Chromium).

Everything that matters lives in `DUET_DATA_DIR` (default `./data`):

| Path | What it is |
|---|---|
| `duet.db` (+ WAL) | items, channels, tasks, files, pages, devices, triggers, settings |
| `files/<id>/` | deliverables the agent produced |
| `uploads/` | photos, PDFs and voice memos you sent |
| `tts/` | synthesized brief audio, cached |
| `internal.token` | loopback token the MCP shim and CLI use |

Back that directory up and you have everything. It is `0700`, and the database is `0600`.

## macOS (launchd)

```sh
bun install && bun run build
hermes-duet install          # ~/Library/LaunchAgents/dev.hermes-duet.server.plist
hermes-duet pair             # code for your phone
hermes-duet doctor
```

Expose it privately with `tailscale serve --bg 7456` (the doctor checks this), then open the URL on the phone and pair.
Set `DUET_PUBLIC_URL` to that URL: iOS push needs it.

## Linux (systemd user unit)

```sh
sudo apt install -y unzip curl
curl -fsSL https://bun.sh/install | bash
bun install && bun run build
hermes-duet install-systemd   # ~/.config/systemd/user/hermes-duet.service
loginctl enable-linger "$USER"   # keep it running with no login session
hermes-duet logs              # journalctl --user -u hermes-duet
```

`hermes-duet doctor`, `pair`, `say`, `brief` and `checkin` work the same. The connectors section will report Calendar,
Reminders and Mail as unsupported on Linux unless you install the tools yourself; the agent can still use any CLI it
finds on `PATH`.

## Docker

```sh
docker build -t hermes-duet .
docker run -d --name hermes-duet \
  -p 7456:7456 \
  -v hermes-duet-data:/data \
  --env-file .env \
  hermes-duet
docker exec hermes-duet bun bin/hermes-duet pair
```

The image bundles Chromium for the live browser pane and reaps it with `tini`. `DUET_HOST=0.0.0.0` inside the
container is what publishes the port; **do not** expose 7456 to the internet — put Tailscale, Cloudflare Tunnel or a
reverse proxy with auth in front of it. Publish only 7456: the internal listener on 7457 must stay on loopback.

The healthcheck hits `/api/health`, which needs no pairing.

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
| `DUET_CHROME_BIN` | Google Chrome on macOS | Chromium binary for the live browser |
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
