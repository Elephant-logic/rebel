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

// Track locked rooms + which socket is host for each room
const lockedRooms = new Set();
const roomHosts = new Map(); // room -> socket.id

io.on('connection', (socket) => {
  // ------------- JOIN ROOM -------------
  socket.on('join-room', ({ room, name, clientType }) => {
    if (!room) return;

    const isViewer = clientType === 'viewer';

    // If locked, block new joins (host + guests + viewers)
    if (lockedRooms.has(room)) {
      socket.emit('room-locked', { room, locked: true });
      return;
    }

    let role = 'guest';

    // Only non-viewers can become host
    if (!isViewer && !roomHosts.has(room)) {
      roomHosts.set(room, socket.id);
      role = 'host';
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';
    socket.data.clientType = clientType || 'app';

    // tell this client their role
    socket.emit('role-assigned', { room, role });

    // broadcast who is host now
    const hostId = roomHosts.get(room) || null;
    io.to(room).emit('host-info', { room, hostId });

    // tell others someone joined
    socket.to(room).emit('user-joined', {
      id: socket.id,
      name: socket.data.name
    });
  });

  // ------------- STREAM (HOST → VIEWERS) -------------

  // host offers to everyone in room
  socket.on('webrtc-offer', (data) => {
    const { room, sdp } = data || {};
    if (!room || !sdp) return;

    const hostId = roomHosts.get(room);
    if (hostId !== socket.id) {
      // only host can stream
      return;
    }

    socket.to(room).emit('webrtc-offer', { sdp });
  });

  // viewer answers back
  socket.on('webrtc-answer', (data) => {
    const { room, sdp } = data || {};
    if (!room || !sdp) return;
    socket.to(room).emit('webrtc-answer', { sdp });
  });

  // ICE for stream
  socket.on('webrtc-ice-candidate', (data) => {
    const { room, candidate } = data || {};
    if (!room || !candidate) return;
    socket.to(room).emit('webrtc-ice-candidate', { candidate });
  });

  // ------------- ROOM CHAT -------------

  socket.on('chat-message', (data) => {
    const { room, name, text } = data || {};
    if (!room || !text) return;
    socket.to(room).emit('chat-message', {
      name: name || 'Anon',
      text,
      ts: Date.now()
    });
  });

  // ------------- FILE SHARE -------------

  socket.on('file-share', (data) => {
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });

  // ------------- ROOM LOCK (HOST ONLY) -------------

  socket.on('lock-room', ({ room, locked }) => {
    if (!room) return;

    const hostId = roomHosts.get(room);
    if (hostId !== socket.id) return;

    if (locked) lockedRooms.add(room);
    else lockedRooms.delete(room);

    io.to(room).emit('room-locked', { room, locked: !!locked });
  });

  // ------------- MULTI VIDEO CALLS (ROOM APP) -------------

  // caller → callee
  socket.on('call-offer', (data) => {
    const { room, targetId, sdp } = data || {};
    if (!room || !targetId || !sdp) return;

    io.to(targetId).emit('call-offer', {
      fromId: socket.id,
      name: socket.data.name || 'Anon',
      sdp
    });
  });

  // callee → caller
  socket.on('call-answer', (data) => {
    const { room, targetId, sdp } = data || {};
    if (!room || !targetId || !sdp) return;

    io.to(targetId).emit('call-answer', {
      fromId: socket.id,
      sdp
    });
  });

  // ICE for room calls
  socket.on('call-ice-candidate', (data) => {
    const { room, targetId, candidate } = data || {};
    if (!room || !targetId || !candidate) return;

    io.to(targetId).emit('call-ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // optional: reject notification
  socket.on('call-reject', (data) => {
    const { room, targetId } = data || {};
    if (!room || !targetId) return;
    io.to(targetId).emit('call-reject', {
      fromId: socket.id
    });
  });

  // ------------- DISCONNECT -------------

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      const hostId = roomHosts.get(room);
      if (hostId === socket.id) {
        roomHosts.delete(room);
      }

      socket.to(room).emit('user-left', { id: socket.id });

      const newHostId = roomHosts.get(room) || null;
      io.to(room).emit('host-info', { room, hostId: newHostId });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
