# Rebel WAN Final

Hybrid WebRTC + Socket.io messenger with:

- 1:1 audio/video calls
- text chat
- emojis
- file send (base64 relay)
- WAN-ready ICE config (STUN + demo TURN)
- Render-compatible Node server

## Structure

- `server/server.js` – signalling server + static hosting
- `server/package.json` – Node dependencies + start script
- `public/` – client files (index.html, app.js, style.css, etc.)
- `config/ice.js` – ICE servers (loaded by index.html)
- `Procfile` – for platforms that use it (Heroku-style)

## Run locally

```bash
cd server
npm install
node server.js
```

Then open `http://localhost:9100` in two browsers/devices, join same room, start a call.

## Deploy to Render

- New Web Service
- Upload this folder (or push to repo)
- Build command: `npm install`
- Start command: `npm start`
- Environment: none required for basic demo
