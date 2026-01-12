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

// Track which rooms are locked and who is the host in each room
const lockedRooms = new Set();
const roomHosts = new Map(); // room -> socket.id

io.on('connection', (socket) => {
  // ------------- JOIN ROOM -------------
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    // If locked, refuse new joins
    if (lockedRooms.has(room)) {
      socket.emit('room-locked', { room, locked: true });
      return;
    }

    let role = 'guest';
    if (!roomHosts.has(room)) {
      // First person to join becomes Host
      roomHosts.set(room, socket.id);
      role = 'host';
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    // Tell this socket what role it is
    socket.emit('role-assigned', { room, role });

    // Tell everyone else someone joined
    socket.to(room).emit('user-joined', {
      id: socket.id,
      name: socket.data.name
    });
  });

  // ------------- STREAM: HOST → VIEWERS -------------

  // Offer from Host to everyone else
  socket.on('webrtc-offer', (data) => {
    const { room, sdp } = data || {};
    if (!room || !sdp) return;

    // Only host for this room is allowed to stream
    const hostId = roomHosts.get(room);
    if (hostId !== socket.id) {
      return;
    }

    socket.to(room).emit('webrtc-offer', { sdp });
  });

  // Viewer answer back to Host
  socket.on('webrtc-answer', (data) => {
    const { room, sdp } = data || {};
    if (!room || !sdp) return;
    socket.to(room).emit('webrtc-answer', { sdp });
  });

  // ICE (stream, both ways)
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

  // ------------- FILE SHARING -------------

  socket.on('file-share', (data) => {
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });

  // ------------- ROOM LOCK (Host only) -------------

  socket.on('lock-room', ({ room, locked }) => {
    if (!room) return;

    const hostId = roomHosts.get(room);
    if (hostId !== socket.id) {
      // Only host can lock / unlock
      return;
    }

    if (locked) {
      lockedRooms.add(room);
    } else {
      lockedRooms.delete(room);
    }
    io.to(room).emit('room-locked', { room, locked: !!locked });
  });

  // ------------- MULTI VIDEO CALLS (room app) -------------

  // Caller → Target: offer
  socket.on('call-offer', (data) => {
    const { room, targetId, sdp } = data || {};
    if (!room || !targetId || !sdp) return;

    io.to(targetId).emit('call-offer', {
      fromId: socket.id,
      name: socket.data.name || 'Anon',
      sdp
    });
  });

  // Callee → Caller: answer
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

  // ------------- DISCONNECT -------------

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      const hostId = roomHosts.get(room);
      if (hostId === socket.id) {
        // Host has gone
        roomHosts.delete(room);
        io.to(room).emit('host-left', { room });
      }

      socket.to(room).emit('user-left', { id: socket.id });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
