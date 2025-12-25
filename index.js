import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import https from 'https';

// Use the PORT provided by the hosting environment (like Render), or 8080 for local development
const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

wss.on('connection', (ws) => {
  let joinedRoom = null;
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { type, room, payload } = data;
    if (!room || !type) return;

    if (type === 'join') {
      if (!rooms.has(room)) {
        rooms.set(room, []);
      }
      const peers = rooms.get(room);
      peers.push(ws);
      joinedRoom = room;
      // Let the new peer know if they are the first one (the "initiator")
      ws.send(JSON.stringify({ type: 'role', payload: { initiator: peers.length === 1 } }));
      return;
    }

    // For all other message types, broadcast to other peers in the room
    const peers = rooms.get(room);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === 1) { // Check if the peer is open
        peer.send(JSON.stringify({ type, payload }));
      }
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    const peers = rooms.get(joinedRoom);
    if (!peers) return;

    // Remove the closed peer from the room
    const index = peers.indexOf(ws);
    if (index !== -1) {
      peers.splice(index, 1);
    }

    // If the room is empty, delete it
    if (peers.length === 0) {
      rooms.delete(joinedRoom);
    }
  });
});

// Endpoint to fetch TURN credentials from Metered
app.get('/turn', (req, res) => {
  // It's best practice to store secrets like API keys in environment variables
  const METERED_DOMAIN = 'hi-presence.metered.live';
  const METERED_API_KEY = process.env.METERED_API_KEY; // <-- Reading from environment variable

  if (!METERED_API_KEY) {
    console.error('METERED_API_KEY environment variable not set.');
    return res.status(500).send('Server configuration error');
  }

  const options = {
    hostname: METERED_DOMAIN,
    path: `/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`,
    method: 'GET',
    headers: {
        "Content-Type": "application/json",
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => (data += chunk));
    apiRes.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*'); // Added for CORS
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    });
  });

  apiReq.on('error', (error) => {
    console.error('Metered API Error:', error);
    res.status(500).send('Error fetching TURN credentials');
  });

  apiReq.end();
});

// Listen on 0.0.0.0 to accept connections from any IP, which is required by Render
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling and TURN server running on port ${PORT}`);
});
