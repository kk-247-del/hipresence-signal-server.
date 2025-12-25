        import { WebSocketServer } from 'ws';
        import express from 'express';
        import http from 'http';
        import https from 'https';

        const PORT = process.env.PORT || 8080;
        const app = express();
        const server = http.createServer(app);
        const wss = new WebSocketServer({ server });
        const rooms = new Map();

        wss.on('connection', (ws) => {
          let joinedRoom = null;
          ws.on('message', (raw) => {
            let data;
            try { data = JSON.parse(raw.toString()); } catch { return; }
            const { type, room, payload } = data;
            if (!room || !type) return;
            if (type === 'join') {
              if (!rooms.has(room)) { rooms.set(room, []); }
              const peers = rooms.get(room);
              peers.push(ws);
              joinedRoom = room;
              ws.send(JSON.stringify({ type: 'role', payload: { initiator: peers.length === 1 } }));
              return;
            }
            const peers = rooms.get(room);
            if (!peers) return;
            for (const peer of peers) {
              if (peer !== ws && peer.readyState === 1) {
                peer.send(JSON.stringify({ type, payload }));
              }
            }
          });
          ws.on('close', () => {
            if (!joinedRoom) return;
            const peers = rooms.get(joinedRoom);
            if (!peers) return;
            const index = peers.indexOf(ws);
            if (index !== -1) peers.splice(index, 1);
            if (peers.length === 0) { rooms.delete(joinedRoom); }
          });
        });

        app.get('/turn', (req, res) => {
          const METERED_DOMAIN = 'hi-presence.metered.live';
          const METERED_API_KEY = 'f2e09edfdbb895db41b6a32601ea7829e629';
          const options = {
            hostname: METERED_DOMAIN,
            path: `/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`,
            method: 'GET',
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

        server.listen(PORT, '0.0.0.0', () => {
          console.log(`Signaling and TURN server running on port ${PORT}`);
        });
        
