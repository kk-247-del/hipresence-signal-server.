import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import https from 'https';
import cors from 'cors';

/* =========================
   CONFIG
   ========================= */

const PORT = process.env.PORT || 8080;

// Safety limits
const MAX_PEERS_PER_ROOM = 6;
const HEARTBEAT_INTERVAL = 15000; // 15s
const STALE_AFTER = 30000;        // 30s
const MAX_MSGS_PER_WINDOW = 60;
const RATE_WINDOW_MS = 10000;

/* =========================
   SERVER SETUP
   ========================= */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());

/**
 * rooms: Map<roomId, Set<WebSocket>>
 * sockets: WeakMap<WebSocket, Meta>
 */
const rooms = new Map();
const sockets = new WeakMap();

/* =========================
   HELPERS
   ========================= */

const now = () => Date.now();

const send = (ws, obj) => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
};

const broadcast = (room, sender, obj) => {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== sender) send(peer, obj);
  }
};

const removePeer = (ws) => {
  const meta = sockets.get(ws);
  if (!meta || !meta.room) return;

  const { room } = meta;
  const peers = rooms.get(room);
  if (!peers) return;

  peers.delete(ws);
  sockets.delete(ws);

  broadcast(room, ws, { type: 'peer-left' });

  if (peers.size === 0) {
    rooms.delete(room);
  }
};

/* =========================
   HEARTBEAT
   ========================= */

const heartbeat = setInterval(() => {
  const time = now();

  for (const ws of sockets.keys()) {
    const meta = sockets.get(ws);
    if (!meta) continue;

    if (time - meta.lastSeen > STALE_AFTER) {
      try {
        ws.terminate();
      } catch {}
      removePeer(ws);
      continue;
    }

    try {
      ws.ping();
    } catch {}
  }
}, HEARTBEAT_INTERVAL);

/* =========================
   WEBSOCKET HANDLING
   ========================= */

wss.on('connection', (ws) => {
  sockets.set(ws, {
    room: null,
    lastSeen: now(),
    rateCount: 0,
    rateReset: now() + RATE_WINDOW_MS,
  });

  ws.on('pong', () => {
    const meta = sockets.get(ws);
    if (meta) meta.lastSeen = now();
  });

  ws.on('message', (raw) => {
    const meta = sockets.get(ws);
    if (!meta) return;

    /* ───── RATE LIMIT ───── */
    const t = now();
    if (t > meta.rateReset) {
      meta.rateCount = 0;
      meta.rateReset = t + RATE_WINDOW_MS;
    }

    meta.rateCount++;
    if (meta.rateCount > MAX_MSGS_PER_WINDOW) return;

    meta.lastSeen = t;

    const text = raw.toString();

    /* ───── JSON SIGNALING ───── */
    try {
      const data = JSON.parse(text);
      const { type, room, payload } = data;
      if (!type || !room) return;

      /* JOIN */
      if (type === 'join') {
        if (!rooms.has(room)) rooms.set(room, new Set());
        const peers = rooms.get(room);

        if (peers.size >= MAX_PEERS_PER_ROOM) return;

        peers.add(ws);
        meta.room = room;

        // Inform presence
        broadcast(room, ws, { type: 'peer-present' });
        if (peers.size > 1) send(ws, { type: 'peer-present' });

        return;
      }

      /* RELAY */
      broadcast(room, ws, { type, payload });
      return;
    } catch {
      /* ───── RAW DATA (LIVE TEXT) ───── */
      if (!meta.room) return;
      const peers = rooms.get(meta.room);
      if (!peers) return;

      for (const peer of peers) {
        if (peer !== ws && peer.readyState === 1) {
          peer.send(text);
        }
      }
    }
  });

  ws.on('close', () => removePeer(ws));
  ws.on('error', () => removePeer(ws));
});

/* =========================
   TURN CREDENTIALS
   ========================= */

app.get('/turn', (req, res) => {
  const METERED_DOMAIN = 'hi-presence.metered.live';
  const METERED_API_KEY = process.env.METERED_API_KEY;

  if (!METERED_API_KEY) {
    return res.status(500).send('Server misconfigured');
  }

  const options = {
    hostname: METERED_DOMAIN,
    path: `/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`,
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (c) => (data += c));
    apiRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    });
  });

  apiReq.on('error', () => {
    res.status(500).send('TURN fetch failed');
  });

  apiReq.end();
});

/* =========================
   START
   ========================= */

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hi Presence signaling server running on ${PORT}`);
});

/* =========================
   OPTIONAL: REDIS SCALING
   ========================= */
/*
If you want horizontal scaling later:

- Use Redis pub/sub
- Replace rooms Map with Redis-backed room registry
- Broadcast via pub/sub instead of local Set

This server is already compatible with that model.
*/
