const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 9100;

const app = express();

// Serve the client folder
app.use(express.static(path.join(__dirname, '..', 'client')));

// Simple health check
app.get('/health', (req, res) => {
  res.json({ ok: true, version: '0.4' });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/signal' });

// roomCode => Set of clients
const rooms = new Map();

function joinRoom(ws, room) {
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  const set = rooms.get(room);

  // Hard‑limit to 2 peers for now
  if (set.size >= 2) {
    ws.send(JSON.stringify({ type: 'room-full', room }));
    return;
  }

  set.add(ws);
  ws.room = room;

  ws.send(JSON.stringify({ type: 'joined', room }));

  // If we now have 2 peers, tell both that the room is ready
  if (set.size === 2) {
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'room-ready', room }));
      }
    }
  }
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room || !rooms.has(room)) return;

  const set = rooms.get(room);
  set.delete(ws);

  if (set.size === 0) {
    rooms.delete(room);
  } else {
    // Tell remaining peer that the other side left
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'peer-left', room }));
      }
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error('Bad JSON from client:', err);
      return;
    }

    const { type, room, payload } = msg;

    switch (type) {
      case 'join':
        joinRoom(ws, room);
        break;

      case 'signal': {
        const set = rooms.get(room);
        if (!set) return;
        for (const client of set) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'signal', room, payload }));
          }
        }
        break;
      }

      case 'chat': {
        const set = rooms.get(room);
        if (!set) return;
        for (const client of set) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'chat',
              room,
              from: payload.from || 'peer',
              text: payload.text || ''
            }));
          }
        }
        break;
      }

      default:
        console.warn('Unhandled message type:', type);
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });

  ws.on('error', (err) => {
    console.error('Socket error:', err);
    leaveRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Rebel Messenger signalling server v0.4 listening on port ${PORT}`);
});