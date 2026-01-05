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
  offer: object | null,
  answer: object | null
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
    room.offer &&
    room.answer
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
          quorum: payload?.quorum ?? 2,
          offer: null,
          answer: null,
        });
      }

      const r = rooms.get(room);
      r.peers.add(ws);

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

      // Late joiners get current offer only
      if (r.offer) send(ws, r.offer);

      maybeEmitMomentReady(room);
      return;
    }

    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    /* ───────── OFFER ───────── */
    if (type === 'offer') {
      r.offer = {
        type: 'offer',
        room: joinedRoom,
        payload,
      };

      r.answer = null; // invalidate any stale answer

      broadcast(joinedRoom, ws, r.offer);
      return;
    }

    /* ───────── ANSWER ───────── */
    if (type === 'answer') {
      if (!r.offer) return;

      r.answer = {
        type: 'answer',
        room: joinedRoom,
        payload,
      };

      broadcast(joinedRoom, ws, r.answer);
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
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    r.peers.delete(ws);

    // Reset negotiation if anyone leaves
    r.offer = null;
    r.answer = null;

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
