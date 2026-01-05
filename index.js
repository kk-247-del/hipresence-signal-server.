import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import cors from 'cors';

const PORT = Number(process.env.PORT);
if (!PORT) throw new Error('PORT not provided');

const app = express();
app.use(cors());
app.get('/', (_, res) => res.status(200).send('Hi Presence signaling server'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Set<WebSocket>,
  armedOfferer: boolean,
  armedJoiner: boolean,
  offererWs: WebSocket | null,
  lastOffer: object | null,
  lastAnswer: object | null
}>
*/
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  for (const ws of room.peers) send(ws, msg);
}
function broadcastExcept(room, sender, msg) {
  for (const ws of room.peers) if (ws !== sender) send(ws, msg);
}

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, room, payload } = msg;
    if (room) roomId = room;
    if (!roomId || !type) return;

    if (type === 'join') {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          peers: new Set(),
          armedOfferer: false,
          armedJoiner: false,
          offererWs: null,
          lastOffer: null,
          lastAnswer: null,
        });
      }
      const roomObj = rooms.get(roomId);
      roomObj.peers.add(ws);

      broadcastExcept(roomObj, ws, { type: 'peer-present', room: roomId, payload: {} });
      send(ws, { type: 'peer-present', room: roomId, payload: {} });

      if (roomObj.lastOffer) send(ws, roomObj.lastOffer);
      if (roomObj.lastAnswer) send(ws, roomObj.lastAnswer);
      return;
    }

    const roomObj = rooms.get(roomId);
    if (!roomObj) return;

    if (type === 'arm-offer') {
      roomObj.armedOfferer = true;
      roomObj.offererWs = ws;
      broadcast(roomObj, { type: 'offerer-armed', room: roomId, payload: {} });
      return;
    }

    if (type === 'arm-join') {
      roomObj.armedJoiner = true;
      broadcast(roomObj, { type: 'joiner-armed', room: roomId, payload: {} });
      return;
    }

    if (type === 'offer') {
      if (!roomObj.armedOfferer || !roomObj.armedJoiner) return;
      if (roomObj.offererWs !== ws) return;

      roomObj.lastOffer = { type: 'offer', room: roomId, payload };
      broadcastExcept(roomObj, ws, roomObj.lastOffer);
      return;
    }

    if (type === 'answer') {
      if (!roomObj.lastOffer) return;
      roomObj.lastAnswer = { type: 'answer', room: roomId, payload };
      broadcastExcept(roomObj, ws, roomObj.lastAnswer);
      return;
    }

    if (type === 'candidate') {
      broadcastExcept(roomObj, ws, { type: 'candidate', room: roomId, payload });
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const roomObj = rooms.get(roomId);
    if (!roomObj) return;

    roomObj.peers.delete(ws);
    if (roomObj.offererWs === ws) {
      roomObj.offererWs = null;
      roomObj.armedOfferer = false;
      roomObj.lastOffer = null;
      roomObj.lastAnswer = null;
    }
    if (roomObj.peers.size === 0) rooms.delete(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence signaling server running on ${PORT}`);
});
