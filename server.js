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

// State: roomName -> Map<socketId, { name }>
const rooms = new Map();

io.on('connection', (socket) => {

  // 1. Join Room
  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    // Create room if missing
    if (!rooms.has(room)) rooms.set(room, new Map());
    const r = rooms.get(room);
    r.set(socket.id, { name: socket.data.name });

    // Notify others in room
    socket.to(room).emit('user-update', { 
      type: 'join', 
      id: socket.id, 
      name: socket.data.name 
    });

    // Send the NEW user the list of EXISTING users
    const userList = Array.from(r.entries()).map(([id, data]) => ({ id, name: data.name }));
    socket.emit('room-users', userList);
  });

  // 2. Targeted WebRTC Signaling
  // This ensures signals go ONLY to the specific person you are calling
  const relay = (type) => (data) => {
    if (data.target && io.sockets.sockets.get(data.target)) {
      io.to(data.target).emit(type, { 
        sender: socket.id, 
        name: socket.data.name,
        ...data 
      });
    }
  };

  socket.on('webrtc-offer', relay('webrtc-offer'));
  socket.on('webrtc-answer', relay('webrtc-answer'));
  socket.on('webrtc-ice-candidate', relay('webrtc-ice-candidate'));

  // 3. Broadcasts (Chat & Files)
  socket.on('chat-message', (data) => socket.to(data.room).emit('chat-message', data));
  socket.on('file-share', (data) => socket.to(data.room).emit('file-share', data));

  // 4. Disconnect
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms.has(room)) {
      const r = rooms.get(room);
      r.delete(socket.id);
      socket.to(room).emit('user-update', { type: 'leave', id: socket.id });
      if (r.size === 0) rooms.delete(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel Server running on port ${PORT}`);
});
