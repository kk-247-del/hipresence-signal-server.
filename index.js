import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

/* ─────────────────────────────────────────────
   BOOTSTRAP
   ───────────────────────────────────────────── */

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(cors());

const server = http.createServer(app);

/* ─────────────────────────────────────────────
   WEBSOCKET SERVER
   ───────────────────────────────────────────── */

const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Set<WebSocket>,
  quorum: number,
  lastOffer: object | null,
  lastAnswer: object | null
}>
*/
const rooms = new Map();

/* ─────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────── */

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

function maybeEmitMomentReady(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (
    room.peers.size >= room.quorum &&
    room.lastOffer &&
    room.lastAnswer
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

/* ─────────────────────────────────────────────
   CONNECTION HANDLING
   ───────────────────────────────────────────── */

wss.on('connection', (ws) => {
  console.log('WS CONNECTED');

  let joinedRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('INVALID JSON');
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
          quorum: payload?.quorum ?? 2,
          lastOffer: null,
          lastAnswer: null,
        });
      }

      const r = rooms.get(room);
      r.peers.add(ws);

      console.log('JOIN', room, 'PEERS', r.peers.size);

      broadcast(room, ws, {
        type: 'peer-present',
        room,
        payload: {},
      });

      send(ws, {
        type: 'peer-present',
        room,
        payload: {},
      });

      if (r.lastOffer) send(ws, r.lastOffer);
      if (r.lastAnswer) send(ws, r.lastAnswer);

      maybeEmitMomentReady(room);
      return;
    }

    if (!joinedRoom || !rooms.has(joinedRoom)) return;
    const r = rooms.get(joinedRoom);

    /* ───────── OFFER ───────── */
    if (type === 'offer') {
      if (r.lastOffer) return;

      r.lastOffer = {
        type: 'offer',
        room: joinedRoom,
        payload,
      };

      console.log('OFFER', joinedRoom);

      broadcast(joinedRoom, ws, r.lastOffer);
      maybeEmitMomentReady(joinedRoom);
      return;
    }

    /* ───────── ANSWER ───────── */
    if (type === 'answer') {
      if (!r.lastOffer || r.lastAnswer) return;

      r.lastAnswer = {
        type: 'answer',
        room: joinedRoom,
        payload,
      };

      console.log('ANSWER', joinedRoom);

      broadcast(joinedRoom, ws, r.lastAnswer);
      maybeEmitMomentReady(joinedRoom);
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
    console.log('WS DISCONNECTED');

    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    r.peers.delete(ws);

    broadcast(joinedRoom, ws, {
      type: 'peer-left',
      room: joinedRoom,
      payload: {},
    });

    if (r.peers.size === 0) {
      rooms.delete(joinedRoom);
    }
  });
});

/* ─────────────────────────────────────────────
   START
   ───────────────────────────────────────────── */

server.listen(PORT, () => {
  console.log(`Hi Presence signaling server running on ${PORT}`);
});
