const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Track locked rooms (no new joins when locked)
const lockedRooms = new Set();

io.on('connection', (socket) => {
  // ---------- ROOM JOIN ----------
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    // If room is locked, refuse new join
    if (lockedRooms.has(room)) {
      socket.emit('room-locked', { room, locked: true });
      return;
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    // Tell everyone else in the room a user joined
    socket.to(room).emit('user-joined', {
      id: socket.id,
      name: socket.data.name
    });
  });

  // ---------- STREAMING / BROADCAST SIGNAL ----------
  // Host → viewers: offer
  socket.on('webrtc-offer', (data) => {
    // { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-offer', { sdp: data.sdp });
  });

  // Viewer → host: answer
  socket.on('webrtc-answer', (data) => {
    // { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-answer', { sdp: data.sdp });
  });

  // ICE both ways (stream)
  socket.on('webrtc-ice-candidate', (data) => {
    // { room, candidate }
    if (!data || !data.room || !data.candidate) return;
    socket.to(data.room).emit('webrtc-ice-candidate', {
      candidate: data.candidate
    });
  });

  // ---------- CHAT RELAY (ROOM-WIDE) ----------
  socket.on('chat-message', (data) => {
    // { room, name, text }
    if (!data || !data.room || !data.text) return;
    socket.to(data.room).emit('chat-message', {
      name: data.name || 'Anon',
      text: data.text,
      ts: Date.now()
    });
  });

  // ---------- FILE RELAY ----------
  socket.on('file-share', (data) => {
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });

  // ---------- ROOM LOCK ----------
  socket.on('lock-room', ({ room, locked }) => {
    if (!room) return;
    if (locked) {
      lockedRooms.add(room);
    } else {
      lockedRooms.delete(room);
    }
    io.to(room).emit('room-locked', { room, locked: !!locked });
  });

  // ---------- MULTI-CALL SIGNAL (ROOM APP, NOT STREAM VIEWER) ----------
  // Caller → Server → Target: offer
  socket.on('call-offer', (data) => {
    // { room, targetId, sdp }
    if (!data || !data.room || !data.targetId || !data.sdp) return;
    io.to(data.targetId).emit('call-offer', {
      fromId: socket.id,
      name: socket.data.name || 'Anon',
      sdp: data.sdp
    });
  });

  // Callee → Server → Caller: answer
  socket.on('call-answer', (data) => {
    // { room, targetId, sdp }
    if (!data || !data.room || !data.targetId || !data.sdp) return;
    io.to(data.targetId).emit('call-answer', {
      fromId: socket.id,
      sdp: data.sdp
    });
  });

  // ICE both ways for calls
  socket.on('call-ice-candidate', (data) => {
    // { room, targetId, candidate }
    if (!data || !data.room || !data.targetId || !data.candidate) return;
    io.to(data.targetId).emit('call-ice-candidate', {
      fromId: socket.id,
      candidate: data.candidate
    });
  });

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('user-left', {
        id: socket.id
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
