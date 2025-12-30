import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import cors from 'cors';

/* =========================
   CONFIG (RELAXED TEST MODE)
   ========================= */

const PORT = process.env.PORT || 8080;

/* =========================
   SERVER SETUP
   ========================= */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());

/**
 * rooms: Map<roomId, Set<WebSocket>>
 */
const rooms = new Map();

/* =========================
   HELPERS
   ========================= */

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

const broadcastExceptSender = (roomId, sender, obj) => {
  const peers = rooms.get(roomId);
  if (!peers) return;

  for (const peer of peers) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      send(peer, obj);
    }
  }
};

/* =========================
   WEBSOCKET HANDLING
   ========================= */

wss.on('connection', (ws) => {
  let room = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, payload } = data;
    room = data.room ?? room;

    if (!room || !type) return;

    /* ───── JOIN (RELAXED) ───── */
    if (type === 'join') {
      if (!rooms.has(room)) {
        rooms.set(room, new Set());
      }

      rooms.get(room).add(ws);

      // Notify presence
      broadcastExceptSender(room, ws, { type: 'peer-present', room });
      send(ws, { type: 'peer-present', room });

      // For testing: announce readiness (does NOT affect SDP)
      broadcastExceptSender(room, null, { type: 'moment-ready', room });
      return;
    }

    /* ───── SDP / ICE RELAY (CRITICAL FIX) ───── */
    if (type === 'offer' || type === 'answer' || type === 'candidate') {
      // 🚫 NEVER echo back to sender
      broadcastExceptSender(room, ws, {
        type,
        room,
        payload,
      });
      return;
    }

    /* ───── OTHER CONTROL MESSAGES ───── */
    broadcastExceptSender(room, ws, {
      type,
      room,
      payload,
    });
  });

  ws.on('close', () => {
    if (room && rooms.has(room)) {
      rooms.get(room).delete(ws);
      broadcastExceptSender(room, ws, { type: 'peer-left', room });

      if (rooms.get(room).size === 0) {
        rooms.delete(room);
      }
    }
  });

  ws.on('error', () => {
    if (room && rooms.has(room)) {
      rooms.get(room).delete(ws);
    }
  });
});

/* =========================
   START
   ========================= */

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚠️ Hi Presence RELAXED signaling server running on ${PORT}`);
});
