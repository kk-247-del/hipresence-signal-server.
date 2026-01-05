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

/* ───────── UTILITIES ───────── */

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(roomObj, msg) {
  for (const peer of roomObj.peers) {
    send(peer, msg);
  }
}

function broadcastExcept(roomObj, sender, msg) {
  for (const peer of roomObj.peers) {
    if (peer !== sender) {
      send(peer, msg);
    }
  }
}

/* ───────── WEBSOCKET ───────── */

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = msg.type;
    const payload = msg.payload;
    if (msg.room) roomId = msg.room;
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

      const roomObj = rooms.get(roomId);
      roomObj.peers.add(ws);

      broadcastExcept(roomObj, ws, {
        type: 'peer-present',
        room: roomId,
        payload: {},
      });

      send(ws, {
        type: 'peer-present',
        room: roomId,
        payload: {},
      });

      if (roomObj.lastOffer) send(ws, roomObj.lastOffer);
      if (roomObj.lastAnswer) send(ws, roomObj.lastAnswer);

      return;
    }

    const roomObj = rooms.get(roomId);
    if (!roomObj) return;

    /* ───── ARM OFFER ───── */
    if (type === 'arm-offer') {
      roomObj.armedOfferer = ws;

      broadcast(roomObj, {
        type: 'offer-armed',
        room: roomId,
        payload: {},
      });

      return;
    }

    /* ───── OFFER ───── */
    if (type === 'offer') {
      if (roomObj.armedOfferer !== ws) return;

      roomObj.lastOffer = {
        type: 'offer',
        room: roomId,
        payload,
      };

      broadcastExcept(roomObj, ws, roomObj.lastOffer);
      return;
    }

    /* ───── ANSWER ───── */
    if (type === 'answer') {
      if (!roomObj.lastOffer) return;

      roomObj.lastAnswer = {
        type: 'answer',
        room: roomId,
        payload,
      };

      broadcastExcept(roomObj, ws, roomObj.lastAnswer);
      return;
    }

    /* ───── ICE ───── */
    if (type === 'candidate') {
      broadcastExcept(roomObj, ws, {
        type: 'candidate',
        room: roomId,
        payload,
      });
    }
  });

  ws.on('close', () => {
    if (!roomId) return;

    const roomObj = rooms.get(roomId);
    if (!roomObj) return;

    roomObj.peers.delete(ws);

    if (roomObj.armedOfferer === ws) {
      roomObj.armedOfferer = null;
      roomObj.lastOffer = null;
      roomObj.lastAnswer = null;
    }

    if (roomObj.peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence signaling server running on ${PORT}`);
});
