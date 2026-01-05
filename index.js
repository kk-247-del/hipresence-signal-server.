import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import cors from 'cors';

const PORT = Number(process.env.PORT);
if (!PORT) {
  throw new Error('PORT not provided');
}

const app = express();
app.use(cors());

app.get('/', (_, res) => {
  res.status(200).send('Hi Presence signaling server');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Set<WebSocket>,
  armedOfferer: WebSocket | null,
  lastOffer: object | null,
  lastAnswer: object | null
}>
*/
const rooms = new Map();

/* ───────── UTIL ───────── */

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg) {
  for (const peer of room.peers) {
    send(peer, msg);
  }
}

function broadcastExcept(room, sender, msg) {
  for (const peer of room.peers) {
    if (peer !== sender) {
      send(peer, msg);
    }
  }
}

/* ───────── WS ───────── */

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, room, payload } = msg;
    if (room) roomId = room;
    if (!roomId || !type) return;

    /* ───── JOIN ───── */
    if (type === 'join') {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          peers: new Set(),
          armedOfferer: null,
          lastOffer: null,
          lastAnswer: null,
        });
      }

      const room = rooms.get(roomId);
      room.peers.add(ws);

      broadcastExcept(room, ws, {
        type: 'peer-present',
        room: roomId,
        payload: {},
      });

      send(ws, {
        type: 'peer-present',
        room: roomId,
        payload: {},
      });

      if (room.lastOffer) send(ws, room.lastOffer);
      if (room.lastAnswer) send(ws, room.lastAnswer);

      return;
    }

    const room = rooms.get(roomId);
    if (!room) return;

    /* ───── ARM OFFER ───── */
    if (type === 'arm-offer') {
      room.armedOfferer = ws;

      broadcast(room, {
        type: 'offer-armed',
        room: roomId,
        payload: {},
      });

      return;
    }

    /* ───── OFFER ───── */
    if (type === 'offer') {
      if (room.armedOfferer !== ws) return;

      room.lastOffer = {
        type: 'offer',
        room: roomId,
        payload,
      };

      broadcastExcept(room, ws, room.lastOffer);
      return;
    }

    /* ───── ANSWER ───── */
    if (type === 'answer') {
      if (!room.lastOffer) return;

      room.lastAnswer = {
        type: 'answer',
        room: roomId,
        payload,
      };

      broadcastExcept(room, ws, room.lastAnswer);
      return;
    }

    /* ───── ICE ───── */
    if (type === 'candidate') {
      broadcastExcept(room, ws, {
        type: 'candidate',
        room: roomId,
        payload,
      });
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.peers.delete(ws);
    if (room.armedOfferer === ws) {
      room.armedOfferer = null;
      room.lastOffer = null;
      room.lastAnswer = null;
    }

    if (room.peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence signaling server running on ${PORT}`);
});
