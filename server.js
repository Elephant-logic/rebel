// server.js – Rebel Messenger: rooms + calls + files + stream

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

// serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// root = app UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------ ROOM STATE ------------
// rooms[roomName] = { hostId, locked, users: Map(socketId -> { name, clientType }) }
const rooms = new Map();

function getOrCreateRoom(roomName) {
  let room = rooms.get(roomName);
  if (!room) {
    room = {
      hostId: null,
      locked: false,
      users: new Map()
    };
    rooms.set(roomName, room);
  }
  return room;
}

function pickRandomName(prefix) {
  return `${prefix}-${Math.floor(Math.random() * 1000)}`;
}

// ------------ SOCKET.IO ------------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;
  socket.data.clientType = 'viewer'; // default; app passes 'app'

  // ---- JOIN ROOM ----
  socket.on('join-room', (data = {}) => {
    const roomName = (data.room || '').trim();
    if (!roomName) return;

    const clientType = data.clientType || 'viewer'; // 'app' for main messenger, 'viewer' for stream page
    const room = getOrCreateRoom(roomName);

    // if room is locked and this isn't the host, block join
    if (room.locked && room.hostId && socket.id !== room.hostId) {
      socket.emit('room-locked', { room: roomName, locked: true });
      return;
    }

    // clean name
    let name = (data.name && String(data.name).trim()) || null;
    if (!name) {
      name =
        clientType === 'app'
          ? pickRandomName('User')
          : pickRandomName('Viewer');
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = name;
    socket.data.clientType = clientType;

    room.users.set(socket.id, { name, clientType });

    // pick host if none and this is an app client
    if (!room.hostId && clientType === 'app') {
      room.hostId = socket.id;
    }

    const role = socket.id === room.hostId ? 'host' : 'guest';

    // tell this client its role (info only; frontend derives real role from host-info)
    socket.emit('role-assigned', { room: roomName, role });

    // broadcast current host to everyone
    io.to(roomName).emit('host-info', {
      room: roomName,
      hostId: room.hostId
    });

    // tell others someone joined
    socket.to(roomName).emit('user-joined', {
      id: socket.id,
      name
    });

    // send existing users to newcomer
    const existing = [];
    for (const [id, user] of room.users) {
      if (id === socket.id) continue;
      existing.push({ id, name: user.name });
    }
    socket.emit('room-users', { room: roomName, users: existing });
  });

  // ---- LOCK / UNLOCK ROOM (host only) ----
  socket.on('lock-room', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    if (!roomName) return;
    const room = rooms.get(roomName);
    if (!room) return;
    if (room.hostId !== socket.id) return; // only host may lock

    room.locked = !!data.locked;
    io.to(roomName).emit('room-locked', {
      room: roomName,
      locked: room.locked
    });
  });

  // ---- STREAM SIGNAL: HOST <-> VIEWERS ----
  socket.on('webrtc-offer', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    if (!roomName || !data.sdp) return;
    socket.to(roomName).emit('webrtc-offer', { sdp: data.sdp });
  });

  socket.on('webrtc-answer', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    if (!roomName || !data.sdp) return;
    socket.to(roomName).emit('webrtc-answer', { sdp: data.sdp });
  });

  socket.on('webrtc-ice-candidate', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    if (!roomName || !data.candidate) return;
    socket.to(roomName).emit('webrtc-ice-candidate', {
      candidate: data.candidate
    });
  });

  // ---- ROOM CALLS (1-to-1 within room) ----
  // caller → server → *target* only
  socket.on('call-offer', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    const targetId = data.targetId;
    const sdp = data.sdp;
    if (!roomName || !targetId || !sdp) return;

    const name = socket.data.name || 'Guest';
    io.to(targetId).emit('call-offer', {
      fromId: socket.id,
      name,
      sdp
    });
  });

  // callee accepted → answer goes back only to caller
  socket.on('call-answer', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    const targetId = data.targetId;
    const sdp = data.sdp;
    if (!roomName || !targetId || !sdp) return;

    io.to(targetId).emit('call-answer', {
      fromId: socket.id,
      sdp
    });
  });

  // ICE candidates for calls – also targeted
  socket.on('call-ice-candidate', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    const targetId = data.targetId;
    const candidate = data.candidate;
    if (!roomName || !targetId || !candidate) return;

    io.to(targetId).emit('call-ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // callee rejected
  socket.on('call-reject', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    const targetId = data.targetId;
    if (!roomName || !targetId) return;

    io.to(targetId).emit('call-reject', {
      fromId: socket.id
    });
  });

  // ---- CHAT ----
  socket.on('chat-message', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    const text = (data.text || '').trim();
    if (!roomName || !text) return;

    const name = data.name || socket.data.name || 'Anon';
    socket.to(roomName).emit('chat-message', {
      name,
      text,
      ts: Date.now()
    });
  });

  // ---- FILE SHARE ----
  socket.on('file-share', (data = {}) => {
    const roomName = (data.room || socket.data.room || '').trim();
    if (!roomName) return;
    socket.to(roomName).emit('file-share', data);
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const room = rooms.get(roomName);
    if (!room) return;

    room.users.delete(socket.id);
    socket.to(roomName).emit('user-left', { id: socket.id });

    // if host left, elect a new host (first remaining app client)
    if (room.hostId === socket.id) {
      room.hostId = null;
      for (const [id, user] of room.users) {
        if (user.clientType === 'app') {
          room.hostId = id;
          break;
        }
      }

      io.to(roomName).emit('host-info', {
        room: roomName,
        hostId: room.hostId
      });

      if (!room.hostId) {
        io.to(roomName).emit('host-left', { room: roomName });
      }
    }

    // clean empty room
    if (room.users.size === 0) {
      rooms.delete(roomName);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
