import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Map<WebSocket, senderId>,
  offer: object | null,
  answer: object | null
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

  for (const ws of room.peers.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) {
      send(ws, msg);
    }
  }
}

function maybeReady(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.offer && room.answer) {
    for (const ws of room.peers.keys()) {
      send(ws, {
        type: 'moment-ready',
        room: roomId,
        payload: {},
      });
    }
  }
}

wss.on('connection', (ws) => {
  let joinedRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, room, payload, sender } = msg;
    if (!type || !room) return;

    /* ───────── JOIN ───────── */
    if (type === 'join') {
      joinedRoom = room;

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Map(),
          offer: null,
          answer: null,
        });
      }

      const r = rooms.get(room);
      r.peers.set(ws, sender);

      const peers = Array.from(r.peers.values());
      const offererId = peers[0]; // FIRST JOINER IS OFFERER

      // Notify presence WITH offererId
      for (const [peerWs] of r.peers) {
        send(peerWs, {
          type: 'peer-present',
          room,
          payload: {
            count: r.peers.size,
            offererId,
          },
        });
      }

      // Replay offer/answer if late join
      if (r.offer) send(ws, r.offer);
      if (r.answer) send(ws, r.answer);

      maybeReady(room);
      return;
    }

    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    /* ───────── OFFER ───────── */
    if (type === 'offer') {
      if (!r.offer) {
        r.offer = {
          type: 'offer',
          room: joinedRoom,
          payload,
        };
        broadcast(joinedRoom, ws, r.offer);
      }
      return;
    }

    /* ───────── ANSWER ───────── */
    if (type === 'answer') {
      if (!r.answer) {
        r.answer = {
          type: 'answer',
          room: joinedRoom,
          payload,
        };
        broadcast(joinedRoom, ws, r.answer);
        maybeReady(joinedRoom);
      }
      return;
    }

    /* ───────── ICE ───────── */
    if (type === 'candidate') {
      broadcast(joinedRoom, ws, {
        type: 'candidate',
        room: joinedRoom,
        payload,
      });
    }
  });

  ws.on('close', () => {
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
  console.log(`Hi Presence signaling on ${PORT}`);
});
