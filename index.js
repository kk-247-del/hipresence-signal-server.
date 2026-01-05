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
  offerer: WebSocket | null,
  answerer: WebSocket | null,
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

function collapseRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peer of room.peers) {
    send(peer, {
      type: 'moment-collapsed',
      room: roomId,
      payload: {},
    });
  }

  rooms.delete(roomId);
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
      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Set(),
          offerer: null,
          answerer: null,
          offer: null,
          answer: null,
        });
      }

      const r = rooms.get(room);

      // STRICT: only 2 peers allowed
      if (r.peers.size >= 2) {
        send(ws, {
          type: 'room-full',
          room,
          payload: {},
        });
        ws.close();
        return;
      }

      joinedRoom = room;
      r.peers.add(ws);

      send(ws, {
        type: 'peer-present',
        room,
        payload: { count: r.peers.size },
      });

      return;
    }

    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    /* ───────── OFFER ───────── */
    if (type === 'offer') {
      // First SDP sender becomes offerer
      if (r.offerer && r.offerer !== ws) return;

      r.offerer = ws;
      r.offer = {
        type: 'offer',
        room: joinedRoom,
        payload,
      };

      // Reset any stale answer
      r.answer = null;
      r.answerer = null;

      for (const peer of r.peers) {
        if (peer !== ws) send(peer, r.offer);
      }
      return;
    }

    /* ───────── ANSWER ───────── */
    if (type === 'answer') {
      if (!r.offer || ws === r.offerer) return;

      r.answerer = ws;
      r.answer = {
        type: 'answer',
        room: joinedRoom,
        payload,
      };

      send(r.offerer, r.answer);

      // Moment becomes alive ONLY here
      send(r.offerer, { type: 'moment-ready', room: joinedRoom, payload: {} });
      send(r.answerer, { type: 'moment-ready', room: joinedRoom, payload: {} });
      return;
    }

    /* ───────── ICE ───────── */
    if (type === 'candidate') {
      for (const peer of r.peers) {
        if (peer !== ws) {
          send(peer, {
            type: 'candidate',
            room: joinedRoom,
            payload,
          });
        }
      }
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    collapseRoom(joinedRoom);
  });
});

/* ─────────────────────────────────────────────
   START
   ───────────────────────────────────────────── */

server.listen(PORT, () => {
  console.log(`Hi Presence strict 2-party signaling on ${PORT}`);
});
