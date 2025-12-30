import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import https from 'https';
import cors from 'cors';

const PORT = process.env.PORT || 8080;

const MAX_PEERS_PER_ROOM = 6;
const HEARTBEAT_INTERVAL = 15000;
const STALE_AFTER = 30000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());

/**
 * rooms: Map<roomId, {
 *   peers: Set<WebSocket>,
 *   quorum: number,
 *   ready: boolean,
 *   signalBuffer: Array<{ sender, msg }>
 * }>
 */
const rooms = new Map();

/**
 * sockets: Map<WebSocket, {
 *   room: string | null,
 *   lastSeen: number,
 *   joined: boolean
 * }>
 */
const sockets = new Map();

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

const removePeer = (ws) => {
  const meta = sockets.get(ws);
  if (!meta) return;

  const roomId = meta.room;
  sockets.delete(ws);

  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.peers.delete(ws);

  broadcast(roomId, ws, { type: 'peer-left', room: roomId });

  if (room.peers.size === 0) {
    rooms.delete(roomId);
  }
};

/* ───────── HEARTBEAT ───────── */

setInterval(() => {
  const t = now();
  for (const [ws, meta] of sockets) {
    if (t - meta.lastSeen > STALE_AFTER) {
      try { ws.terminate(); } catch {}
      removePeer(ws);
    } else {
      try { ws.ping(); } catch {}
    }
  }
}, HEARTBEAT_INTERVAL);

/* ───────── WS ───────── */

wss.on('connection', (ws) => {
  sockets.set(ws, {
    room: null,
    lastSeen: now(),
    joined: false,
  });

  ws.on('pong', () => {
    const meta = sockets.get(ws);
    if (meta) meta.lastSeen = now();
  });

  ws.on('message', (raw) => {
    const meta = sockets.get(ws);
    if (!meta) return;

    meta.lastSeen = now();

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    let { type, room, payload } = data;
    if (!type || !room) return;

    if (type === 'ice') type = 'candidate';

    /* ───── JOIN ───── */
    if (type === 'join') {
      if (meta.joined) return;

      const quorum = typeof payload?.quorum === 'number' ? payload.quorum : 2;

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Set(),
          quorum,
          ready: false,
          signalBuffer: [],
        });
      }

      const roomState = rooms.get(room);
      if (roomState.peers.size >= MAX_PEERS_PER_ROOM) return;

      meta.room = room;
      meta.joined = true;
      roomState.peers.add(ws);

      broadcast(room, ws, { type: 'peer-present', room });
      send(ws, { type: 'peer-present', room });

      // Flush buffered SDP
      if (roomState.peers.size > 1 && roomState.signalBuffer.length) {
        for (const { sender, msg } of roomState.signalBuffer) {
          broadcast(room, sender, msg);
        }
        roomState.signalBuffer = [];
      }

      // Presence-only readiness (optional UI signal)
      if (!roomState.ready && roomState.peers.size >= roomState.quorum) {
        roomState.ready = true;
        for (const peer of roomState.peers) {
          send(peer, { type: 'moment-ready', room });
        }
      }

      return;
    }

    /* ───── REQUIRE JOIN ───── */
    if (!meta.joined) return;

    const roomState = rooms.get(room);
    if (!roomState) return;

    const msg = { type, room, payload };

    /* ───── SDP / ICE RELAY ───── */
    if (type === 'offer' || type === 'answer' || type === 'candidate') {
      if (roomState.peers.size < 2) {
        roomState.signalBuffer.push({ sender: ws, msg });
      } else {
        broadcast(room, ws, msg);
      }
      return;
    }

    /* ───── OTHER CONTROL MESSAGES ───── */
    broadcast(room, ws, msg);
  });

  ws.on('close', () => removePeer(ws));
  ws.on('error', () => removePeer(ws));
});

/* ───────── TURN ───────── */

app.get('/turn', (req, res) => {
  const DOMAIN = 'hi-presence.metered.live';
  const KEY = process.env.METERED_API_KEY;
  if (!KEY) return res.status(500).send('TURN not configured');

  https.get(
    `https://${DOMAIN}/api/v1/turn/credentials?apiKey=${KEY}`,
    (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.send(d);
      });
    },
  ).on('error', () => res.status(500).send('TURN failed'));
});

/* ───────── START ───────── */

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hi Presence signaling server running on ${PORT}`);
});
