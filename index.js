import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import cors from 'cors';

const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());

/**
 * rooms: Map<roomId, {
 *   peers: Map<WebSocket, { role: 'offerer' | 'answerer' | null }>,
 *   quorum: number,
 *   lastOffer: object | null,
 *   lastAnswer: object | null
 * }>
 */
const rooms = new Map();

/* ─────────────────────────────────────────────
   UTILITIES
   ───────────────────────────────────────────── */

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

const broadcastExceptSender = (roomId, sender, obj) => {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peer of room.peers.keys()) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      send(peer, obj);
    }
  }
};

const maybeEmitMomentReady = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return;

  const ready =
    room.peers.size >= room.quorum &&
    room.lastOffer !== null &&
    room.lastAnswer !== null;

  if (!ready) return;

  for (const peer of room.peers.keys()) {
    send(peer, { type: 'moment-ready', room: roomId });
  }
};

/* ─────────────────────────────────────────────
   WEBSOCKET HANDLING
   ───────────────────────────────────────────── */

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, payload } = msg;
    roomId = msg.room ?? roomId;
    if (!roomId || !type) return;

    /* ───────── JOIN ───────── */
    if (type === 'join') {
      const quorum = payload?.quorum ?? 2;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          peers: new Map(),
          quorum,
          lastOffer: null,
          lastAnswer: null,
        });
      }

      const room = rooms.get(roomId);

      room.peers.set(ws, { role: null });

      // Notify others
      broadcastExceptSender(roomId, ws, {
        type: 'peer-present',
        room: roomId,
      });

      // Notify self
      send(ws, { type: 'peer-present', room: roomId });

      // 🔁 Replay SDP IN ORDER
      if (room.lastOffer) send(ws, room.lastOffer);
      if (room.lastAnswer) send(ws, room.lastAnswer);

      // Only emit moment-ready if conditions are truly met
      maybeEmitMomentReady(roomId);
      return;
    }

    /* ───────── OFFER ───────── */
    if (type === 'offer') {
      const room = rooms.get(roomId);
      if (!room) return;

      // ❌ Reject second offer
      if (room.lastOffer) return;

      room.lastOffer = { type: 'offer', room: roomId, payload };
      room.peers.get(ws).role = 'offerer';

      broadcastExceptSender(roomId, ws, room.lastOffer);
      maybeEmitMomentReady(roomId);
      return;
    }

    /* ───────── ANSWER ───────── */
    if (type === 'answer') {
      const room = rooms.get(roomId);
      if (!room) return;

      // ❌ No answer without offer
      if (!room.lastOffer) return;

      // ❌ Reject second answer
      if (room.lastAnswer) return;

      room.lastAnswer = { type: 'answer', room: roomId, payload };
      room.peers.get(ws).role = 'answerer';

      broadcastExceptSender(roomId, ws, room.lastAnswer);
      maybeEmitMomentReady(roomId);
      return;
    }

    /* ───────── ICE ───────── */
    if (type === 'candidate') {
      const room = rooms.get(roomId);
      if (!room) return;

      // Only forward ICE AFTER SDP exchange exists
      if (!room.lastOffer || !room.lastAnswer) return;

      broadcastExceptSender(roomId, ws, {
        type: 'candidate',
        room: roomId,
        payload,
      });
      return;
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.peers.delete(ws);

    broadcastExceptSender(roomId, ws, {
      type: 'peer-left',
      room: roomId,
    });

    if (room.peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

/* ─────────────────────────────────────────────
   SERVER START
   ───────────────────────────────────────────── */

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Hi Presence signaling server running on ${PORT}`);
});
