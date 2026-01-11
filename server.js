const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, version: 'rebel-broadcast' });
});

// Room State
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Guest';
    
    // Notify ONLY the host/others that a new user is here
    // The Host will use this ID to start a specific connection
    socket.to(room).emit('user-joined', socket.id);
    console.log(`User ${socket.id} joined room ${room}`);
  });

  socket.on('leave-room', () => {
    const room = socket.data.room;
    if (room) {
      socket.leave(room);
      socket.to(room).emit('user-left', socket.id);
    }
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('user-left', socket.id);
    }
  });

  // --- GENERIC SIGNALING (The Switchboard) ---
  // We use this for Offer, Answer, and ICE Candidates
  // It routes the message specifically to 'target' socket
  socket.on('signal', ({ target, type, payload }) => {
    io.to(target).emit('signal', {
      from: socket.id,
      type,
      payload
    });
  });

  // Chat and Files (Broadcast to room)
  socket.on('chat-message', (data) => {
    if (data.room) io.to(data.room).emit('chat-message', { ...data, ts: Date.now() });
  });

  socket.on('file-share', (data) => {
    if (data.room) socket.to(data.room).emit('file-share', data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel Broadcast server running on port ${PORT}`);
});
