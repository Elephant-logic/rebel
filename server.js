// ==================================================
// REBEL SERVER — Multi-call + Broadcast Stream
// Layout: root/server.js + /public/*
// ==================================================
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---------- STATIC FILES ----------
// All your HTML/JS/CSS live in /public
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Root route -> public/index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// room -> { users: [ { id, name } ] }
const rooms = {};

// ==================================================
//  SOCKET LOGIC
// ==================================================
io.on('connection', (socket) => {

  // ===== JOIN MAIN ROOM (chat + calls) =====
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || `User-${String(Math.random()).slice(2, 6)}`;

    if (!rooms[room]) rooms[room] = { users: [] };
    rooms[room].users.push({ id: socket.id, name: socket.data.name });

    // update user list for everyone
    io.to(room).emit('room-users', rooms[room].users);
  });

  // ===== 1:1 CALL SIGNALS (host <-> peers) =====
  // These event names MUST match app.js
  socket.on('webrtc-offer-call', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('webrtc-offer-call', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-answer-call', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('webrtc-answer-call', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-ice-call', ({ targetId, candidate }) => {
    if (!targetId || !candidate) return;
    io.to(targetId).emit('webrtc-ice-call', { fromId: socket.id, candidate });
  });

  // ===== VIEWERS JOIN STREAM ROOM =====
  // viewer.js does: join-stream { streamRoom: 'stream-ROOM' }
  socket.on('join-stream', ({ streamRoom }) => {
    if (!streamRoom) return;

    socket.join(streamRoom);
    socket.data.streamRoom = streamRoom;

    const baseRoom = streamRoom.replace(/^stream-/, '');
    // tell host(s) in base room that a viewer arrived
    io.to(baseRoom).emit('viewer-joined');
  });

  // ===== STREAM SDP (HOST <-> VIEWERS) =====
  // host → viewers
  socket.on('webrtc-offer-stream', ({ sdp, streamRoom }) => {
    if (!streamRoom || !sdp) return;
    socket.to(streamRoom).emit('webrtc-offer-stream', { sdp });
  });

  // viewer → host
  socket.on('webrtc-answer-stream', ({ sdp, streamRoom }) => {
    if (!streamRoom || !sdp) return;
    const baseRoom = streamRoom.replace(/^stream-/, '');
    io.to(baseRoom).emit('webrtc-answer-stream', { sdp });
  });

  // ICE for stream (both directions)
  socket.on('webrtc-ice-stream', ({ candidate, streamRoom }) => {
    if (!streamRoom || !candidate) return;
    const baseRoom = streamRoom.replace(/^stream-/, '');
    // send ICE to viewers in the stream room
    socket.to(streamRoom).emit('webrtc-ice-stream', { candidate });
    // and to host(s) in the main room
    socket.to(baseRoom).emit('webrtc-ice-stream', { candidate });
  });

  // ===== CHAT & FILES =====
  socket.on('chat-message', ({ room, name, text }) => {
    if (!room || !text) return;
    io.to(room).emit('chat-message', { name: name || 'Anon', text });
  });

  socket.on('file-share', ({ room, name, filename, content }) => {
    if (!room || !filename || !content) return;
    io.to(room).emit('file-share', { name: name || 'Anon', filename, content });
  });

  // ===== DISCONNECT =====
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms[room]) {
      rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
      io.to(room).emit('room-users', rooms[room].users);
      if (!rooms[room].users.length) delete rooms[room];
    }
  });
});

// ==================================================
//  START SERVER  (Render uses PORT env)
// ==================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`REBEL server running on port ${PORT}`);
});
