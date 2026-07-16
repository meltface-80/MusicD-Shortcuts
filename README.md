<div align="center"> 

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

</div>

# MusicD Shortcuts

A self-hosted **Roon extension** that plays a **random album** — optionally
filtered by genre — into a Roon zone when you hit a simple `GET` webhook URL.
That makes it trivial to trigger from an **iPhone/iOS Shortcut** (and Android
HTTP-shortcut apps): tap an icon or say *"Hey Siri, Play Random Jazz."*

It pairs with your Roon Core over the LAN and serves a small web dashboard (PWA)
for creating and copying webhook URLs. No cloud, no account, no subscription.

**Website & full guide:** https://meltface-80.github.io/MusicD-Shortcuts/

## Six ready-made webhooks

Seeded automatically on first run:

| Webhook | Slug |
| --- | --- |
| Any Album | `/w/any-album` |
| Random Pop/Rock | `/w/random-pop-rock` |
| Random Metal | `/w/random-metal` |
| Random Jazz | `/w/random-jazz` |
| Random Electronic | `/w/random-electronic` |
| Random Trip-Hop | `/w/random-trip-hop` |

Create your own for any genre in your library — either in **Roon → Settings →
Extensions → MusicD Shortcuts**, or in the built-in dashboard.

Webhook URL shape: `http://<YOUR_SERVER_LAN_IP>:3000/w/<slug>` ·
dashboard: `http://<YOUR_SERVER_LAN_IP>:3000/`

## Quick start (Docker)

Host networking is required on Linux so the extension can discover your Roon
Core over UDP broadcast.

```bash
git clone https://github.com/meltface-80/MusicD-Shortcuts.git
cd MusicD-Shortcuts
# (optional) edit docker-compose.yml to set:
#   PUBLIC_BASE_URL=http://YOUR_SERVER_LAN_IP:3000
docker compose up -d
```

Then open **Roon → Settings → Extensions** and click **Enable** next to
"MusicD Shortcuts" to pair. Set `PUBLIC_BASE_URL` to this server's LAN address
so the webhook URLs shown are reachable from your phone (otherwise a LAN IP is
auto-detected).

## Add it to an iPhone Shortcut

1. Copy a webhook URL from the dashboard (or the Roon extension settings).
2. Shortcuts app → **+** → add action **Get Contents of URL**.
3. Paste the URL; ensure **Method** is **GET**.
4. Name it naturally, e.g. **"Play Random Jazz"** (Siri responds to that phrase).
5. Optionally add it to the Home Screen or a widget.
6. Tap it, or say *"Hey Siri, Play Random Jazz"* while on your home Wi-Fi.

Android: use an HTTP-request shortcut app pointed at the same GET URL. The phone
must be on the same LAN as the server (or you must expose it yourself).

## Development

```bash
npm install   # installs git-based Roon deps + Express
npm test      # runs the full node:test suite (must stay green)
npm start     # runs the extension (needs a Roon Core on the LAN)
```

- **Node 22+ required** — uses the built-in `node:sqlite` module (no native build).
- The `node-roon-api*` packages are **not on the public npm registry**; they are
  pulled as **git dependencies** from the official RoonLabs GitHub repos. No
  vendored tarballs.

## License

MIT
