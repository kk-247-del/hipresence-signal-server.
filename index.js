import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import https from 'https';
import cors from 'cors';

/* =========================
   CONFIG
   ========================= */

const PORT = process.env.PORT || 8080;

const MAX_PEERS_PER_ROOM = 6;
const HEARTBEAT_INTERVAL = 15000;
const STALE_AFTER = 30000;
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
 * rooms: Map<roomId, {
 *   peers: Set<WebSocket>,
 *   quorum: number,
 *   ready: boolean
 * }>
 *
 * sockets: Map<WebSocket, {
 *   room: string | null,
 *   lastSeen: number,
 *   rateCount: number,
 *   rateReset: number,
 *   joined: boolean
 * }>
 */
const rooms = new Map();
const sockets = new Map();

/* =========================
   HELPERS
   ========================= */

const now = () => Date.now();

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

const broadcast = (roomId, sender, obj) => {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peer of room.peers) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      send(peer, obj);
    }
  }
};

const drop = (ws, reason) => {
  try {
    send(ws, { type: 'error', reason });
  } catch {}
  try {
    ws.terminate();
  } catch {}
  removePeer(ws);
};

const removePeer = (ws) => {
  const meta = sockets.get(ws);
  if (!meta) return;

  const roomId = meta.room;
  sockets.delete(ws);

  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.peers.delete(ws);

  broadcast(roomId, ws, { type: 'peer-left' });

  if (room.ready && room.peers.size < room.quorum) {
    room.ready = false;
    broadcast(roomId, null, { type: 'moment-collapsed' });
  }

  if (room.peers.size === 0) {
    rooms.delete(roomId);
  }
};

/* =========================
   HEARTBEAT
   ========================= */

setInterval(() => {
  const time = now();

  for (const [ws, meta] of sockets.entries()) {
    if (time - meta.lastSeen > STALE_AFTER) {
      try { ws.terminate(); } catch {}
      removePeer(ws);
      continue;
    }

    try { ws.ping(); } catch {}
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
    joined: false,
  });

  ws.on('pong', () => {
    const meta = sockets.get(ws);
    if (meta) meta.lastSeen = now();
  });

  ws.on('message', (raw) => {
    const meta = sockets.get(ws);
    if (!meta) return;

    const t = now();
    meta.lastSeen = t;

    // Rate limiting
    if (t > meta.rateReset) {
      meta.rateCount = 0;
      meta.rateReset = t + RATE_WINDOW_MS;
    }
    if (++meta.rateCount > MAX_MSGS_PER_WINDOW) {
      return drop(ws, 'rate-limit');
    }

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    let { type, room, payload } = data;
    if (!type || !room) {
      return drop(ws, 'invalid-envelope');
    }

    // Normalize ICE naming
    if (type === 'ice') type = 'candidate';

    /* ───── JOIN ───── */
    if (type === 'join') {
      if (meta.joined) return;

      const quorum =
        typeof payload?.quorum === 'number'
          ? payload.quorum
          : 2;

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Set(),
          quorum,
          ready: false,
        });
      }

      const roomState = rooms.get(room);

      if (roomState.peers.size >= MAX_PEERS_PER_ROOM) {
        return drop(ws, 'room-full');
      }

      meta.room = room;
      meta.joined = true;
      roomState.peers.add(ws);

      broadcast(room, ws, { type: 'peer-present' });
      if (roomState.peers.size > 1) {
        send(ws, { type: 'peer-present' });
      }

      if (!roomState.ready && roomState.peers.size >= roomState.quorum) {
        roomState.ready = true;
        for (const peer of roomState.peers) {
          send(peer, { type: 'moment-ready' });
        }
      }

      return;
    }

    /* ───── ENFORCE JOIN FIRST ───── */
    if (!meta.joined) {
      return drop(ws, 'join-required');
    }

    /* ───── SIGNAL RELAY ───── */
    broadcast(room, ws, { type, payload });
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
