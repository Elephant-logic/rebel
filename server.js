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

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// In-memory room state
// ----------------------------------------------------
const rooms = Object.create(null);

function getRoomInfo(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      ownerId: null,
      locked: false,
      streamTitle: 'Untitled Stream', 
      users: new Map()
    };
  }
  return rooms[roomName];
}

function broadcastRoomUpdate(roomName) {
  const room = rooms[roomName];
  if (!room) return;

  const users = [];
  for (const [id, u] of room.users.entries()) {
    users.push({ id, name: u.name });
  }

  io.to(roomName).emit('room-update', {
    users,
    ownerId: room.ownerId,
    locked: room.locked,
    streamTitle: room.streamTitle
  });
}

// ----------------------------------------------------
// Socket.io
// ----------------------------------------------------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // --- JOIN ---
  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') {
      socket.emit('room-error', 'Invalid room');
      return;
    }

    const roomName = room.trim();
    const displayName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;
    const info = getRoomInfo(roomName);

    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked by host');
      return;
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    if (!info.ownerId) {
      info.ownerId = socket.id;
    }

    info.users.set(socket.id, { name: displayName });

    socket.emit('role', { 
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle
    });

    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });
    broadcastRoomUpdate(roomName);
  });

  // --- HOST ACTIONS ---
  socket.on('lock-room', (locked) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    info.locked = (typeof locked === 'boolean') ? locked : !info.locked;
    broadcastRoomUpdate(roomName);
  });

  socket.on('update-stream-title', (title) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    info.streamTitle = title || 'Untitled Stream';
    broadcastRoomUpdate(roomName);
  });

  socket.on('kick-user', (targetId) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;
    if (!info.users.has(targetId)) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.leave(roomName);
      targetSocket.data.room = null;
    }
    info.users.delete(targetId);
    broadcastRoomUpdate(roomName);
  });

  // --- WEBRTC ---
  socket.on('webrtc-offer', ({ room, sdp }) => {
    const roomName = room || socket.data.room;
    if (roomName && sdp) socket.to(roomName).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    const roomName = room || socket.data.room;
    if (roomName && sdp) socket.to(roomName).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    const roomName = room || socket.data.room;
    if (roomName && candidate) socket.to(roomName).emit('webrtc-ice-candidate', { candidate });
  });

  // --- CALLING ---
  socket.on('call-offer', ({ targetId, offer }) => {
    if (targetId && offer) io.to(targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer });
  });
  socket.on('call-answer', ({ targetId, answer }) => {
    if (targetId && answer) io.to(targetId).emit('call-answer', { from: socket.id, answer });
  });
  socket.on('call-ice', ({ targetId, candidate }) => {
    if (targetId && candidate) io.to(targetId).emit('call-ice', { from: socket.id, candidate });
  });
  socket.on('call-end', ({ targetId }) => {
    if (targetId) io.to(targetId).emit('call-end', { from: socket.id });
  });
  socket.on('ring-user', (targetId) => {
    if (targetId) io.to(targetId).emit('ring-alert', { from: socket.data.name, fromId: socket.id });
  });

  // --- CHAT & FILES (SEPARATED) ---
  
  // 1. Public Stream Chat (Viewers + Room)
  socket.on('public-chat', ({ room, name, text, fromViewer }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    const info = rooms[roomName];
    
    io.to(roomName).emit('public-chat', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now(),
      isOwner: info && info.ownerId === socket.id,
      fromViewer: !!fromViewer
    });
  });

  // 2. Private Room Chat (Room Only)
  socket.on('private-chat', ({ room, name, text }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    
    io.to(roomName).emit('private-chat', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now()
    });
  });

  socket.on('file-share', ({ room, name, fileName, fileType, fileData }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !fileName || !fileData) return;
    io.to(roomName).emit('file-share', {
      name: name || socket.data.name,
      fileName,
      fileType: fileType || 'application/octet-stream',
      fileData
    });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const info = rooms[roomName];
    if (!info) return;

    info.users.delete(socket.id);

    if (info.ownerId === socket.id) {
      info.ownerId = null;
      info.locked = false;
    }

    socket.to(roomName).emit('user-left', { id: socket.id });

    if (info.users.size === 0) {
      delete rooms[roomName];
    } else {
      broadcastRoomUpdate(roomName);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
