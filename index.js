import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import https from 'https';
import cors from 'cors';

const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());

/**
 * rooms: Map<roomId, Set<WebSocket>>
 */
const rooms = new Map();

/* =========================
   WEBSOCKET SIGNALLING
   ========================= */

wss.on('connection', (ws) => {
  let joinedRoom = null;

  const send = (socket, obj) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(obj));
    }
  };

  const broadcast = (room, sender, obj) => {
    const peers = rooms.get(room);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== sender) {
        send(peer, obj);
      }
    }
  };

  const handleSignalingMessage = (data) => {
    const { type, room, payload } = data;
    if (!type || !room) return;

    /* ───── JOIN ───── */
    if (type === 'join') {
      if (!rooms.has(room)) {
        rooms.set(room, new Set());
      }

      const peers = rooms.get(room);
      peers.add(ws);
      joinedRoom = room;

      console.log(`[WS] Peer joined room ${room}. Count=${peers.size}`);

      // Inform existing peers that someone is present
      broadcast(room, ws, { type: 'peer-present' });

      // Inform the new peer that others (if any) are present
      if (peers.size > 1) {
        send(ws, { type: 'peer-present' });
      }

      return;
    }

    /* ───── RELAY ALL OTHER SIGNALING ───── */
    broadcast(room, ws, { type, payload });
  };

  const handleRawData = (message) => {
    if (!joinedRoom) return;
    const peers = rooms.get(joinedRoom);
    if (!peers) return;

    for (const peer of peers) {
      if (peer !== ws && peer.readyState === 1) {
        peer.send(message);
      }
    }
  };

  ws.on('message', (rawMessage) => {
    const text = rawMessage.toString();
    try {
      const json = JSON.parse(text);
      handleSignalingMessage(json);
    } catch {
      handleRawData(text);
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;

    const peers = rooms.get(joinedRoom);
    if (!peers) return;

    peers.delete(ws);
    console.log(`[WS] Peer left room ${joinedRoom}. Remaining=${peers.size}`);

    // Notify remaining peers that presence degraded
    broadcast(joinedRoom, ws, { type: 'peer-left' });

    if (peers.size === 0) {
      rooms.delete(joinedRoom);
      console.log(`[WS] Room ${joinedRoom} deleted`);
    }
  });
});

/* =========================
   TURN CREDENTIALS
   ========================= */

app.get('/turn', (req, res) => {
  const METERED_DOMAIN = 'hi-presence.metered.live';
  const METERED_API_KEY = process.env.METERED_API_KEY;

  if (!METERED_API_KEY) {
    console.error('METERED_API_KEY not set');
    return res.status(500).send('Server misconfigured');
  }

  const options = {
    hostname: METERED_DOMAIN,
    path: `/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`,
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (c) => (data += c));
    apiRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    });
  });

  apiReq.on('error', (err) => {
    console.error('Metered error:', err);
    res.status(500).send('TURN fetch failed');
  });

  apiReq.end();
});

/* =========================
   START SERVER
   ========================= */

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hi Presence signaling server running on ${PORT}`);
});
