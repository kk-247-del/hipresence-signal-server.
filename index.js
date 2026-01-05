import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

app.get('/', (_, res) => {
  res.status(200).send('Hi Presence signaling server alive');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Set<WebSocket>,
  lastOffer: object | null,
  lastAnswer: object | null
}>
*/
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(roomId, except, msg) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peer of room.peers) {
    if (peer !== except) {
      send(peer, msg);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('WS CONNECTED');
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, room, payload } = msg;

    if (type === 'join') {
      console.log('JOIN', room);

      roomId = room;

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Set(),
          lastOffer: null,
          lastAnswer: null,
        });
      }

      const r = rooms.get(room);
      r.peers.add(ws);

      // ACK self
      send(ws, { type: 'peer-present', room, payload: {} });

      // Notify others
      broadcast(room, ws, { type: 'peer-present', room, payload: {} });

      // 🔑 REPLAY SDP IF IT EXISTS
      if (r.lastOffer) send(ws, r.lastOffer);
      if (r.lastAnswer) send(ws, r.lastAnswer);

      return;
    }

    if (!roomId || !rooms.has(roomId)) return;

    const r = rooms.get(roomId);

    if (type === 'offer') {
      r.lastOffer = msg;
      broadcast(roomId, ws, msg);
      return;
    }

    if (type === 'answer') {
      r.lastAnswer = msg;
      broadcast(roomId, ws, msg);
      return;
    }

    // ICE
    broadcast(roomId, ws, msg);
  });

  ws.on('close', () => {
    if (!roomId || !rooms.has(roomId)) return;

    const r = rooms.get(roomId);
    r.peers.delete(ws);

    if (r.peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`SIGNALING SERVER RUNNING ON ${PORT}`);
});
