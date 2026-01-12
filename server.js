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

// ----------------------------------------------------
// In-memory room state
// ----------------------------------------------------
// rooms = {
//   [roomName]: {
//      ownerId: <socket.id>,
//      locked: boolean,
//      users: Map<socketId, { name: string }>
//   }
// }
const rooms = Object.create(null);

// ----------------------------------------------------
// Static files
// ----------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
function getRoomInfo(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      ownerId: null,
      locked: false,
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
    locked: room.locked
  });
}

// ----------------------------------------------------
// Socket.io
// ----------------------------------------------------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // Join a room (host or guest or viewer – client decides role UX)
  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') {
      socket.emit('room-error', 'Invalid room');
      return;
    }

    const roomName = room.trim();
    const displayName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;

    const info = getRoomInfo(roomName);

    // If room locked and this socket is not the owner, reject
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked by host');
      return;
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    // First user becomes owner/host if not already set
    if (!info.ownerId) {
      info.ownerId = socket.id;
    }

    info.users.set(socket.id, { name: displayName });

    // Tell this client its role
    socket.emit('role', { isHost: info.ownerId === socket.id });

    // Inform others that a user joined (used by host to auto re-offer stream)
    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });

    // Full room snapshot
    broadcastRoomUpdate(roomName);
  });

  // --------------------------------------------------
  // Room lock / unlock (host only)
  // --------------------------------------------------
  socket.on('lock-room', (locked) => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return; // only host

    if (typeof locked === 'boolean') {
      info.locked = locked;
    } else {
      info.locked = !info.locked;
    }

    broadcastRoomUpdate(roomName);
  });

  // --------------------------------------------------
  // Kick user (host only)
  // --------------------------------------------------
  socket.on('kick-user', (targetId) => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return; // only host

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

  // --------------------------------------------------
  // Stream signalling (host -> viewers, uses webrtc-*)
  // This matches existing app.js / viewer.js behaviour.
  // --------------------------------------------------
  socket.on('webrtc-offer', ({ room, sdp }) => {
    const roomName = room || socket.data.room;
    if (!roomName) return;
    // Host sends to everyone else in the room (viewers + guests)
    socket.to(roomName).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    const roomName = room || socket.data.room;
    if (!roomName) return;
    // Viewer/guest sends back to host
    socket.to(roomName).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    const roomName = room || socket.data.room;
    if (!roomName) return;
    socket.to(roomName).emit('webrtc-ice-candidate', { candidate });
  });

  // --------------------------------------------------
  // Call signalling (Feature Pack, used by upgraded app.js)
  // Viewers will never receive these because they’re only
  // sent to specific socket IDs (targetId).
  // --------------------------------------------------
  socket.on('call-offer', ({ targetId, offer }) => {
    if (!targetId || !offer) return;
    io.to(targetId).emit('incoming-call', {
      from: socket.id,
      name: socket.data.name || `User-${socket.id.slice(0, 4)}`,
      offer
    });
  });

  socket.on('call-answer', ({ targetId, answer }) => {
    if (!targetId || !answer) return;
    io.to(targetId).emit('call-answer', {
      from: socket.id,
      answer
    });
  });

  socket.on('call-ice', ({ targetId, candidate }) => {
    if (!targetId || !candidate) return;
    io.to(targetId).emit('call-ice', {
      from: socket.id,
      candidate
    });
  });

  socket.on('call-reject', ({ targetId }) => {
    if (!targetId) return;
    io.to(targetId).emit('call-reject', {
      from: socket.id
    });
  });

  socket.on('call-end', ({ targetId }) => {
    if (!targetId) return;
    io.to(targetId).emit('call-end', {
      from: socket.id
    });
  });

  socket.on('call-hangup-all', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return; // only host can hang up all

    for (const targetId of info.users.keys()) {
      if (targetId === socket.id) continue;
      io.to(targetId).emit('call-end', { from: socket.id });
    }
  });

  // --------------------------------------------------
  // Ring user (old behaviour) – still supported
  // --------------------------------------------------
  socket.on('ring-user', (targetId) => {
    if (!targetId) return;
    const fromName = socket.data.name || `User-${socket.id.slice(0, 4)}`;
    io.to(targetId).emit('ring-alert', { from: fromName, fromId: socket.id });
  });

  // --------------------------------------------------
  // Chat
  // --------------------------------------------------
  socket.on('chat-message', ({ room, name, text }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    const info = rooms[roomName];
    const ts = Date.now();

    const isOwner = info && info.ownerId === socket.id;

    io.to(roomName).emit('chat-message', {
      name: name || socket.data.name || `User-${socket.id.slice(0, 4)}`,
      text,
      ts,
      isOwner
    });
  });

  // --------------------------------------------------
  // File share
  // --------------------------------------------------
  socket.on('file-share', ({ room, name, fileName, fileType, fileData }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !fileName || !fileData) return;

    io.to(roomName).emit('file-share', {
      name: name || socket.data.name || `User-${socket.id.slice(0, 4)}`,
      fileName,
      fileType: fileType || 'application/octet-stream',
      fileData
    });
  });

  // --------------------------------------------------
  // Disconnect
  // --------------------------------------------------
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const info = rooms[roomName];
    if (!info) return;

    info.users.delete(socket.id);

    // If owner left, keep room but without owner (next joiner could become owner)
    if (info.ownerId === socket.id) {
      info.ownerId = null;
      info.locked = false;
    }

    // Inform others for legacy handlers
    socket.to(roomName).emit('user-left', { id: socket.id });

    if (info.users.size === 0) {
      delete rooms[roomName];
    } else {
      broadcastRoomUpdate(roomName);
    }
  });
});

// ----------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
