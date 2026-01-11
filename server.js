// server.js - Full File
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// serve static files from /public
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// simple health check
app.get('/health', (req, res) => {
  res.json({ ok: true, version: 'rebel-messenger' });
});

// roomId -> Set(socketId)
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Guest';

    if (!rooms.has(room)) {
      rooms.set(room, new Set());
    }
    rooms.get(room).add(socket.id);

    // --- CRITICAL FIX: Notify Host that someone joined ---
    socket.to(room).emit('user-joined', socket.id); 
    // ----------------------------------------------------

    socket.to(room).emit('system-message', `${socket.data.name} joined`);
    io.to(socket.id).emit('system-message', `Joined room: ${room}`);
  });

  socket.on('leave-room', () => {
    leaveRoom(socket);
  });

  socket.on('chat-message', ({ room, name, text }) => {
    if (!room || !text) return;
    io.to(room).emit('chat-message', {
      name: name || socket.data.name || 'Guest',
      text,
      ts: Date.now()
    });
  });

  // simple file relay
  socket.on('file-share', ({ room, name, fileName, fileType, fileSize, fileData }) => {
    if (!room || !fileName || !fileData) return;
    socket.to(room).emit('file-share', {
      from: name || socket.data.name || 'Guest',
      fileName,
      fileType,
      fileSize,
      fileData
    });
  });

  // WebRTC signalling relays
  socket.on('webrtc-offer', ({ room, sdp }) => {
    if (!room || !sdp) return;
    socket.to(room).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    if (!room || !sdp) return;
    socket.to(room).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    if (!room || !candidate) return;
    socket.to(room).emit('webrtc-ice-candidate', { candidate });
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
    console.log('Client disconnected', socket.id);
  });
});

function leaveRoom(socket) {
  const room = socket.data.room;
  if (!room) return;
  socket.leave(room);
  const set = rooms.get(room);
  if (set) {
    set.delete(socket.id);
    if (set.size === 0) rooms.delete(room);
  }
  socket.to(room).emit('system-message', `${socket.data.name} left`);
  socket.data.room = null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel Messenger server listening on port ${PORT}`);
});
