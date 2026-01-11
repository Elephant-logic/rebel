// server.js
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

  // ---- ROOM JOIN / LEAVE ----
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    // tell others in that room someone arrived
    socket.to(room).emit('user-joined', { id: socket.id, name: name || 'guest' });
  });

  socket.on('leave-room', ({ room }) => {
    if (!room) return;
    socket.leave(room);
    socket.to(room).emit('user-left', { id: socket.id });
  });

  socket.on('disconnecting', () => {
    const rooms = [...socket.rooms].filter(r => r !== socket.id);
    rooms.forEach((room) => {
      socket.to(room).emit('user-left', { id: socket.id });
    });
  });

  // ---- WEBRTC (call + stream – room based) ----
  socket.on('webrtc-offer', (data) => {
    // data: { room, sdp }
    if (!data || !data.room) return;
    socket.to(data.room).emit('webrtc-offer', data);
  });

  socket.on('webrtc-answer', (data) => {
    // data: { room, sdp }
    if (!data || !data.room) return;
    socket.to(data.room).emit('webrtc-answer', data);
  });

  socket.on('webrtc-ice-candidate', (data) => {
    // data: { room, candidate }
    if (!data || !data.room) return;
    socket.to(data.room).emit('webrtc-ice-candidate', data);
  });

  // ---- STREAM HELLO (viewer asks host for a fresh offer) ----
  socket.on('stream-hello', (data) => {
    // just bounce to everyone else in that stream room
    if (!data || !data.room) return;
    socket.to(data.room).emit('stream-hello', data);
  });

  // ---- CHAT & FILES ----
  socket.on('chat-message', (data) => {
    // data: { room, name, text, ts }
    if (!data || !data.room) return;
    socket.to(data.room).emit('chat-message', data);
  });

  socket.on('file-share', (data) => {
    // data: { room, ... }
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
