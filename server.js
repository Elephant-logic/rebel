// Rebel Hybrid Server (Host Mesh + Broadcast View)
// Supports: 1–8 callers + unlimited viewers

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*" } });

// Store room users: Map(room -> Map(socketId -> {id,name}))
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {

  // JOIN ROOM (CALL ROOM)
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    const safeName = name && name.trim() ? name.trim() : `User-${String(Math.random()).slice(2,6)}`;
    socket.data.room = room;
    socket.data.name = safeName;

    socket.join(room);

    if (!rooms.has(room)) rooms.set(room, new Map());
    const roomMap = rooms.get(room);
    roomMap.set(socket.id, { id: socket.id, name: safeName });

    // broadcast updated user list
    io.to(room).emit('room-users', Array.from(roomMap.values()));
  });

  // JOIN VIEWER STREAM ROOM
  socket.on('join-stream', ({ streamRoom }) => {
    socket.join(streamRoom);
    socket.data.streamRoom = streamRoom;

    // Tell host/viewers someone joined the view stream
    io.to(streamRoom).emit('viewer-joined', { id: socket.id });
  });

  // WEBRTC: CALL MODE (direct to peer)
  socket.on('webrtc-offer-call', ({ targetId, sdp, room }) => {
    io.to(targetId).emit('webrtc-offer-call', { fromId: socket.id, sdp, room });
  });

  socket.on('webrtc-answer-call', ({ targetId, sdp, room }) => {
    io.to(targetId).emit('webrtc-answer-call', { fromId: socket.id, sdp, room });
  });

  socket.on('webrtc-ice-call', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-call', { fromId: socket.id, candidate });
  });

  // WEBRTC: BROADCAST MODE (to unlimited viewers)
  socket.on('webrtc-offer-stream', ({ sdp, streamRoom }) => {
    socket.to(streamRoom).emit('webrtc-offer-stream', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-answer-stream', ({ sdp, streamRoom }) => {
    socket.to(streamRoom).emit('webrtc-answer-stream', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-ice-stream', ({ candidate, streamRoom }) => {
    socket.to(streamRoom).emit('webrtc-ice-stream', { fromId: socket.id, candidate });
  });

  // CHAT
  socket.on('chat-message', ({ room, name, text, ts }) => {
    socket.to(room).emit('chat-message', { name, text, ts });
  });

  // FILE SHARING
  socket.on('file-share', (data) => {
    const { room } = data;
    socket.to(room).emit('file-share', data);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms.has(room)) {
      const roomMap = rooms.get(room);
      roomMap.delete(socket.id);
      if (roomMap.size === 0) {
        rooms.delete(room);
      } else {
        io.to(room).emit('room-users', Array.from(roomMap.values()));
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel Hybrid server running on port ${PORT}`);
});
