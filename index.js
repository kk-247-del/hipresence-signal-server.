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
 *   peers: Set<WebSocket>,
 *   lastOffer: object | null,
 *   lastAnswer: object | null
 * }>
 */
const rooms = new Map();

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

const broadcastExceptSender = (roomId, sender, obj) => {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peer of room.peers) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      send(peer, obj);
    }
  }
};

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, payload } = data;
    roomId = data.room ?? roomId;
    if (!roomId || !type) return;

    /* ───── JOIN ───── */
    if (type === 'join') {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          peers: new Set(),
          lastOffer: null,
          lastAnswer: null,
        });
      }

      const room = rooms.get(roomId);
      room.peers.add(ws);

      broadcastExceptSender(roomId, ws, { type: 'peer-present', room: roomId });
      send(ws, { type: 'peer-present', room: roomId });

      // 🔑 REPLAY SDP IF IT EXISTS
      if (room.lastOffer) send(ws, room.lastOffer);
      if (room.lastAnswer) send(ws, room.lastAnswer);

      broadcastExceptSender(roomId, null, { type: 'moment-ready', room: roomId });
      return;
    }

    /* ───── OFFER ───── */
    if (type === 'offer') {
      const room = rooms.get(roomId);
      if (!room) return;

      room.lastOffer = { type: 'offer', room: roomId, payload };
      broadcastExceptSender(roomId, ws, room.lastOffer);
      return;
    }

    /* ───── ANSWER ───── */
    if (type === 'answer') {
      const room = rooms.get(roomId);
      if (!room) return;

      room.lastAnswer = { type: 'answer', room: roomId, payload };
      broadcastExceptSender(roomId, ws, room.lastAnswer);
      return;
    }

    /* ───── ICE ───── */
    if (type === 'candidate') {
      broadcastExceptSender(roomId, ws, { type, room: roomId, payload });
      return;
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    room.peers.delete(ws);
    broadcastExceptSender(roomId, ws, { type: 'peer-left', room: roomId });
    if (room.peers.size === 0) rooms.delete(roomId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Hi Presence RELIABLE signaling server running on ${PORT}`);
});
