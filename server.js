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

// serve /public
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// track locked rooms for the Lock Room button
const lockedRooms = new Set();

io.on('connection', (socket) => {
  // ------------- JOIN ROOM -------------
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    // if room is locked, tell client and bail
    if (lockedRooms.has(room)) {
      socket.emit('room-locked', { room, locked: true });
      return;
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    // tell existing members that someone joined
    socket.to(room).emit('user-joined', {
      id: socket.id,
      name: socket.data.name
    });
  });

  // ------------- STREAMING (HOST → VIEWERS) -------------

  // host sends offer to everyone in room
  socket.on('webrtc-offer', (data) => {
    // { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-offer', { sdp: data.sdp });
  });

  // viewer answers back to host
  socket.on('webrtc-answer', (data) => {
    // { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-answer', { sdp: data.sdp });
  });

  // ICE for stream (both ways)
  socket.on('webrtc-ice-candidate', (data) => {
    // { room, candidate }
    if (!data || !data.room || !data.candidate) return;
    socket.to(data.room).emit('webrtc-ice-candidate', {
      candidate: data.candidate
    });
  });

  // ------------- ROOM CHAT -------------

  socket.on('chat-message', (data) => {
    // { room, name, text }
    if (!data || !data.room || !data.text) return;
    socket.to(data.room).emit('chat-message', {
      name: data.name || 'Anon',
      text: data.text,
      ts: Date.now()
    });
  });

  // ------------- FILE SHARE -------------

  socket.on('file-share', (data) => {
    // just relay everything to the room
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });

  // ------------- ROOM LOCK -------------

  socket.on('lock-room', ({ room, locked }) => {
    if (!room) return;
    if (locked) {
      lockedRooms.add(room);
    } else {
      lockedRooms.delete(room);
    }
    io.to(room).emit('room-locked', { room, locked: !!locked });
  });

  // ------------- MULTI VIDEO CALLS (CALL / END) -------------

  // caller → target: offer
  socket.on('call-offer', (data) => {
    // { room, targetId, sdp }
    if (!data || !data.room || !data.targetId || !data.sdp) return;

    io.to(data.targetId).emit('call-offer', {
      fromId: socket.id,
      name: socket.data.name || 'Anon',
      sdp: data.sdp
    });
  });

  // callee → caller: answer
  socket.on('call-answer', (data) => {
    // { room, targetId, sdp }
    if (!data || !data.room || !data.targetId || !data.sdp) return;

    io.to(data.targetId).emit('call-answer', {
      fromId: socket.id,
      sdp: data.sdp
    });
  });

  // ICE for the room calls
  socket.on('call-ice-candidate', (data) => {
    // { room, targetId, candidate }
    if (!data || !data.room || !data.targetId || !data.candidate) return;

    io.to(data.targetId).emit('call-ice-candidate', {
      fromId: socket.id,
      candidate: data.candidate
    });
  });

  // ------------- DISCONNECT -------------

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('user-left', { id: socket.id });
    }
  });
});

// start
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
