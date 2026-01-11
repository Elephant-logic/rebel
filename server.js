const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    // Tell Host a user is here so they can start the stream
    socket.to(room).emit('user-joined', socket.id);
  });

  // Relay Calls
  socket.on('webrtc-offer', (data) => socket.to(data.room).emit('webrtc-offer', data));
  socket.on('webrtc-answer', (data) => socket.to(data.room).emit('webrtc-answer', data));
  socket.on('webrtc-ice-candidate', (data) => socket.to(data.room).emit('webrtc-ice-candidate', data));
  
  // Relay Chat
  socket.on('chat-message', (data) => io.to(data.room).emit('chat-message', data));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${PORT}`));
