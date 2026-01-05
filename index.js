import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import cors from 'cors';

const PORT = Number(process.env.PORT);
if (!PORT) {
  throw new Error('PORT not provided by Render');
}

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * rooms: Map<roomId, {
 *   peers: Map<WebSocket, { role: 'offerer' | 'answerer' | null }>,
 *   quorum: number,
 *   lastOffer: object | null,
 *   lastAnswer: object | null
 * }>
 */
const rooms = new Map();

/* ───────── Utilities ───────── */

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
    send(peer, {
      type: 'moment-ready',
      room: roomId,
      payload: {},
    });
  }
};

/* ───────── WebSocket ───────── */

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

      broadcastExceptSender(roomId, ws, {
        type: 'peer-present',
        room: roomId,
        payload: {},
      });

      if (room.lastOffer) send(ws, room.lastOffer);
      if (room.lastAnswer) send(ws, room.lastAnswer);

      maybeEmitMomentReady(roomId);
      return;
    }

    if (type === 'offer') {
      const room = rooms.get(roomId);
      if (!room || room.lastOffer) return;

      room.lastOffer = {
        type: 'offer',
        room: roomId,
        payload: { sdp: payload.sdp },
      };

      room.peers.get(ws).role = 'offerer';
      broadcastExceptSender(roomId, ws, room.lastOffer);
      maybeEmitMomentReady(roomId);
      return;
    }

    if (type === 'answer') {
      const room = rooms.get(roomId);
      if (!room || !room.lastOffer || room.lastAnswer) return;

      room.lastAnswer = {
        type: 'answer',
        room: roomId,
        payload: { sdp: payload.sdp },
      };

      room.peers.get(ws).role = 'answerer';
      broadcastExceptSender(roomId, ws, room.lastAnswer);
      maybeEmitMomentReady(roomId);
      return;
    }

    if (type === 'candidate') {
      const room = rooms.get(roomId);
      if (!room) return;

      broadcastExceptSender(roomId, ws, {
        type: 'candidate',
        room: roomId,
        payload,
      });
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.peers.delete(ws);

    broadcastExceptSender(roomId, ws, {
      type: 'peer-left',
      room: roomId,
      payload: {},
    });

    if (room.peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on ${PORT}`);
});
