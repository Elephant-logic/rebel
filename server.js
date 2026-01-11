// ==================================================
//  REBEL SERVER — Multi-call + Broadcast Stream
// ==================================================
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from this folder
app.use(express.static(__dirname));

// Root → index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// room -> { users: [ {id,name} ] }
const rooms = {};

io.on('connection', (socket) => {
  // -------- JOIN MAIN ROOM --------
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || `User-${String(Math.random()).slice(2, 6)}`;

    if (!rooms[room]) rooms[room] = { users: [] };
    rooms[room].users.push({ id: socket.id, name: socket.data.name });

    io.to(room).emit('room-users', rooms[room].users);
  });

  // -------- DIRECT CALL SDP --------
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

  // -------- VIEWER JOIN STREAM ROOM --------
  socket.on('join-stream', ({ streamRoom }) => {
    if (!streamRoom) return;
    socket.join(streamRoom);
    socket.data.streamRoom = streamRoom;

    // tell host(s) someone is watching
    const baseRoom = streamRoom.replace(/^stream-/, '');
    io.to(baseRoom).emit('viewer-joined');
  });

  // -------- STREAM SDP (HOST <-> VIEWERS) --------
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

  // ICE for stream (both ways)
  socket.on('webrtc-ice-stream', ({ candidate, streamRoom }) => {
    if (!streamRoom || !candidate) return;
    const baseRoom = streamRoom.replace(/^stream-/, '');
    socket.to(streamRoom).emit('webrtc-ice-stream', { candidate });
    socket.to(baseRoom).emit('webrtc-ice-stream', { candidate });
  });

  // -------- CHAT + FILES --------
  socket.on('chat-message', ({ room, name, text }) => {
    if (!room || !text) return;
    io.to(room).emit('chat-message', { name: name || 'Anon', text });
  });

  socket.on('file-share', ({ room, name, filename, content }) => {
    if (!room || !filename || !content) return;
    io.to(room).emit('file-share', { name: name || 'Anon', filename, content });
  });

  // -------- DISCONNECT --------
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms[room]) {
      rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
      io.to(room).emit('room-users', rooms[room].users);
      if (!rooms[room].users.length) delete rooms[room];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`REBEL server running on port ${PORT}`);
});
