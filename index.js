import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

// ✅ REQUIRED FOR RENDER
app.get('/', (_, res) => {
  res.status(200).send('Hi Presence signaling server alive');
});

const server = http.createServer(app);

// ✅ EXPLICIT WS SERVER
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Set<WebSocket>,
  quorum: number
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

  let joinedRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log('INVALID JSON');
      return;
    }

    const { type, room, payload } = msg;

    if (type === 'join') {
      console.log('JOIN RECEIVED', room);

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Set(),
          quorum: payload?.quorum ?? 2,
        });
      }

      const r = rooms.get(room);
      r.peers.add(ws);
      joinedRoom = room;

      // ACK SELF
      send(ws, {
        type: 'peer-present',
        room,
        payload: {},
      });

      // NOTIFY OTHERS
      broadcast(room, ws, {
        type: 'peer-present',
        room,
        payload: {},
      });

      return;
    }

    // RELAY EVERYTHING ELSE
    if (joinedRoom) {
      broadcast(joinedRoom, ws, msg);
    }
  });

  ws.on('close', () => {
    console.log('WS CLOSED');

    if (!joinedRoom) return;

    const r = rooms.get(joinedRoom);
    if (!r) return;

    r.peers.delete(ws);
    if (r.peers.size === 0) {
      rooms.delete(joinedRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`SIGNALING SERVER RUNNING ON ${PORT}`);
});
