# Bella Stream

Private 2-person watch rooms with:

- YouTube / direct-video sync in the room
- Chrome tab/window share for sites that block embeds
- chat, reactions, and camera bubbles

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:5173 — the Socket.IO server runs on http://localhost:3001.

## Deploy (Netlify + Socket server)

Netlify hosts the **static React app**. Rooms, chat, and WebRTC signaling need a **persistent Node Socket.IO server** (Render, Railway, or Fly). Netlify Functions cannot keep WebSocket rooms alive.

### 1. Deploy the signaling server (Render example)

1. Push this repo to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Settings:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Instance:** free/starter is fine for 2-person rooms
4. Environment variables:
   - `CORS_ORIGIN=https://YOUR-SITE.netlify.app,http://localhost:5173`
5. Copy the public service URL, e.g. `https://bella-stream.onrender.com`
6. Confirm health: `https://bella-stream.onrender.com/api/health`

### 2. Deploy the client on Netlify

1. New site from the same GitHub repo
2. Build settings (also in `netlify.toml`):
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
3. Environment variable (Site settings → Environment variables):
   - `VITE_SOCKET_URL=https://bella-stream.onrender.com`
4. Deploy

After changing `VITE_SOCKET_URL`, trigger a new Netlify deploy so Vite bakes it into the client bundle.

### 3. Optional: one host for everything

If you only want Render (no Netlify), the server also serves `dist/` after `npm run build`. Set `CORS_ORIGIN=*` or your Render URL and open the Render site directly.

## Environment

See `.env.example`.

| Variable | Where | Purpose |
|---|---|---|
| `VITE_SOCKET_URL` | Netlify build | Socket.IO server URL for the browser |
| `CORS_ORIGIN` | Socket host | Allowed web app origins |
| `PORT` | Socket host | Defaults to `3001` (cloud hosts usually inject `PORT`) |

## Notes

- Screen share and camera need HTTPS (Netlify provides this).
- Pause on a shared tab freezes Bella’s feed; pause the movie site itself separately if needed.
- Free Render services may sleep when idle — the first reconnect can take ~30s.
