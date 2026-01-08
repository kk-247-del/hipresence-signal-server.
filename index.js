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
  peers: Set<WebSocket>,
  offer: object | null,
  answer: object | null,
  readyPeers: Set<WebSocket>
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
    if (peer !== except && peer.readyState === peer.OPEN) {
      send(peer, msg);
    }
  }
}

function maybeReady(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // 🔒 HARD RULE: everyone must be transport-ready
  if (
    room.offer &&
    room.answer &&
    room.readyPeers.size === room.peers.size &&
    room.peers.size > 0
  ) {
    for (const peer of room.peers) {
      send(peer, {
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

    const { type, room, payload } = msg;
    if (!type || !room) return;

    /* ───────── JOIN ───────── */
    if (type === 'join') {
      joinedRoom = room;

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Set(),
          offer: null,
          answer: null,
          readyPeers: new Set(),
        });
      }

      const r = rooms.get(room);
      r.peers.add(ws);

      // presence update
      for (const peer of r.peers) {
        send(peer, {
          type: 'peer-present',
          room,
          payload: { count: r.peers.size },
        });
      }

      // replay signaling if late join
      if (r.offer) send(ws, r.offer);
      if (r.answer) send(ws, r.answer);

      return;
    }

    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);

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
      return;
    }

    /* ───────── TRANSPORT READY ───────── */
    if (type === 'transport-ready') {
      r.readyPeers.add(ws);
      maybeReady(joinedRoom);
      return;
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    r.peers.delete(ws);
    r.readyPeers.delete(ws);

    if (r.peers.size === 0) {
      rooms.delete(joinedRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence rendezvous signaling on ${PORT}`);
});
