const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'User';
    
    // THE TRIGGER: Tell everyone else in room that someone joined
    socket.to(room).emit('user-joined', socket.id); 
    
    console.log(`${name} joined ${room}`);
  });

  // Simple Relay for WebRTC Signals
  socket.on('webrtc-offer', (data) => socket.to(data.room).emit('webrtc-offer', data));
  socket.on('webrtc-answer', (data) => socket.to(data.room).emit('webrtc-answer', data));
  socket.on('webrtc-ice-candidate', (data) => socket.to(data.room).emit('webrtc-ice-candidate', data));
  
  // Chat & Files
  socket.on('chat-message', (data) => io.to(data.room).emit('chat-message', data));

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${PORT}`));
