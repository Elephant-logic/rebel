const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// roomName -> Set(socketId)
const rooms = new Map();

io.on('connection', (socket) => {
  socket.data.rooms = new Set();

  // ---- JOIN / LEAVE ----
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    socket.join(room);
    socket.data.rooms.add(room);

    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(socket.id);

    // Let others know someone joined
    socket.to(room).emit('user-joined', { id: socket.id, name: name || 'Guest' });
  });

  socket.on('leave-room', ({ room }) => {
    if (!room) return;
    socket.leave(room);
    socket.data.rooms.delete(room);

    const set = rooms.get(room);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) rooms.delete(room);
    }

    socket.to(room).emit('user-left', { id: socket.id });
  });

  socket.on('disconnect', () => {
    for (const room of socket.data.rooms || []) {
      socket.to(room).emit('user-left', { id: socket.id });
      const set = rooms.get(room);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) rooms.delete(room);
      }
    }
  });

  // ---- WEBRTC SIGNAL RELAY ----
  socket.on('webrtc-offer', (data) => {
    if (!data.room) return;
    socket.to(data.room).emit('webrtc-offer', data);
  });

  socket.on('webrtc-answer', (data) => {
    if (!data.room) return;
    socket.to(data.room).emit('webrtc-answer', data);
  });

  socket.on('webrtc-ice-candidate', (data) => {
    if (!data.room) return;
    socket.to(data.room).emit('webrtc-ice-candidate', data);
  });

  // ---- CHAT ----
  socket.on('chat-message', (data) => {
    if (!data.room) return;
    // don’t echo back to sender (they already append locally)
    socket.to(data.room).emit('chat-message', data);
  });

  // ---- FILES ----
  socket.on('file-share', (data) => {
    if (!data.room) return;
    socket.to(data.room).emit('file-share', data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server listening on port ${PORT}`);
});
