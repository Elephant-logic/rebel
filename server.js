const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// roomName -> { hostId, locked, users: Map<socketId, {id, name}> }
const rooms = new Map();

io.on('connection', (socket) => {
  
  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    let r = rooms.get(room);
    if (!r) {
      r = { hostId: socket.id, locked: false, users: new Map() };
      rooms.set(room, r);
    }
    
    // Notify others
    socket.to(room).emit('user-joined', { id: socket.id, name: socket.data.name });
    
    // Send list of existing users to the new guy (so they know who to connect to)
    const existingUsers = Array.from(r.users.values());
    socket.emit('existing-users', existingUsers);

    r.users.set(socket.id, { id: socket.id, name: socket.data.name });
  });

  // --- GENERIC WEBRTC SIGNALING (Targeted) ---
  // We forward 'target' so only the specific peer receives the signal
  const signalHandler = (type) => (data) => {
    if (data.target) {
      io.to(data.target).emit(type, { ...data, sender: socket.id });
    } else {
      socket.to(data.room).emit(type, { ...data, sender: socket.id });
    }
  };

  socket.on('webrtc-offer', signalHandler('webrtc-offer'));
  socket.on('webrtc-answer', signalHandler('webrtc-answer'));
  socket.on('webrtc-ice-candidate', signalHandler('webrtc-ice-candidate'));

  // --- UTILS ---
  socket.on('chat-message', (data) => {
    socket.to(data.room).emit('chat-message', data);
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms.has(room)) {
      const r = rooms.get(room);
      r.users.delete(socket.id);
      socket.to(room).emit('user-left', { id: socket.id });
      if (r.users.size === 0) rooms.delete(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Rebel 2.0 running on ${PORT}`));
