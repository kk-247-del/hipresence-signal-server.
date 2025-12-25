import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import https from 'https';
import cors from 'cors'; // For allowing browser connections

// Use the PORT provided by the hosting environment, or 8080 for local dev
const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// === MIDDLEWARE ===
// This tells your server to accept requests from any origin.
app.use(cors());
// ==================

const rooms = new Map();

wss.on('connection', (ws) => {
  let joinedRoom = null;

  // This function handles JSON messages for signaling (join, ready, etc.)
  const handleSignalingMessage = (data) => {
    const { type, room, payload } = data;
    if (!room || !type) return;

    if (type === 'join') {
      if (!rooms.has(room)) {
        rooms.set(room, []);
      }
      const peers = rooms.get(room);
      // Add the user to the room if they aren't already in it
      if (!peers.includes(ws)) {
        peers.push(ws);
      }
      joinedRoom = room;

      console.log(`Peer joined room [${room}]. Total peers: ${peers.length}`);

      // Let the new peer know their role (initiator or not)
      ws.send(JSON.stringify({ type: 'role', payload: { initiator: peers.length === 1 } }));

      // --- CRITICAL LOGIC ---
      // If the room now has 2 participants, tell EVERYONE it's ready.
      if (peers.length === 2) {
        console.log(`Room [${room}] is now ready. Broadcasting 'ready' signal.`);
        for (const peer of peers) {
          peer.send(JSON.stringify({ type: 'ready' }));
        }
      }
      return;
    }
    
    // For all other signaling messages, broadcast to other peers
    const peers = rooms.get(room);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === 1) {
        peer.send(JSON.stringify({ type, payload }));
      }
    }
  };
  
  // This function handles raw data that is not JSON, like live text
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
    const messageAsString = rawMessage.toString();
    try {
      // Try to parse it as a JSON signaling message
      const data = JSON.parse(messageAsString);
      handleSignalingMessage(data);
    } catch (e) {
      // If it's not JSON, it's live text from the other user
      handleRawData(messageAsString);
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    const peers = rooms.get(joinedRoom);
    if (!peers) return;

    const index = peers.indexOf(ws);
    if (index !== -1) {
      peers.splice(index, 1);
    }
    
    console.log(`Peer left room [${joinedRoom}]. Remaining peers: ${peers.length}`);

    // If the room is now empty, delete it.
    if (peers.length === 0) {
      console.log(`Room [${joinedRoom}] is empty, deleting.`);
      rooms.delete(joinedRoom);
    }
  });
});

// Endpoint to fetch TURN credentials from Metered
app.get('/turn', (req, res) => {
  const METERED_DOMAIN = 'hi-presence.metered.live';
  const METERED_API_KEY = process.env.METERED_API_KEY;

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

// Listen on 0.0.0.0 to accept connections from any IP
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling and TURN server running on port ${PORT}`);
});
