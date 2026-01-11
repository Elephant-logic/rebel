const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);

// CORS allowed for all
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // Join Room
  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    // Notify others that a user joined (Triggers the Host to start stream)
    socket.to(room).emit('user-joined', socket.id);
  });

  // Relay Video Signals (One-to-One / One-to-Many)
  socket.on('webrtc-offer', (data) => socket.to(data.room).emit('webrtc-offer', data));
  socket.on('webrtc-answer', (data) => socket.to(data.room).emit('webrtc-answer', data));
  socket.on('webrtc-ice-candidate', (data) => socket.to(data.room).emit('webrtc-ice-candidate', data));
  
  // FIX: Chat only goes to OTHERS (prevents double messages)
  socket.on('chat-message', (data) => {
    socket.to(data.room).emit('chat-message', data);
  });

  socket.on('disconnect', () => {
    // Optional cleanup
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${PORT}`));
