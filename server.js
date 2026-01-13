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

// In-memory room state
// rooms[name] = { ownerId, locked, users: Map<socketId, {name}>, streamTitle }
const rooms = {};

function normaliseRoomName(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase();
}

function getRoomInfo(roomName) {
  return rooms[roomName] || null;
}

function broadcastRoomUpdate(roomName) {
  const info = getRoomInfo(roomName);
  if (!info) return;

  const users = [];
  info.users.forEach((u, id) => {
    users.push({ id, name: u.name });
  });

  io.to(roomName).emit('room-update', {
    room: roomName,
    ownerId: info.ownerId,
    locked: info.locked,
    streamTitle: info.streamTitle,
    users
  });
}

function leaveCurrentRoom(socket) {
  const roomName = socket.data.room;
  if (!roomName) return;
  const info = getRoomInfo(roomName);
  if (!info) return;

  info.users.delete(socket.id);
  socket.leave(roomName);
  socket.data.room = null;

  socket.to(roomName).emit('user-left', { id: socket.id });

  // If host left, pick a new host if anyone is left
  if (info.ownerId === socket.id) {
    const remaining = Array.from(info.users.keys());
    info.ownerId = remaining[0] || null;
  }

  if (info.users.size === 0) {
    delete rooms[roomName];
  } else {
    broadcastRoomUpdate(roomName);
  }
}

// SOCKET.IO LOGIC
io.on('connection', (socket) => {
  socket.data.room = null;

  // --- JOIN ROOM ---
  socket.on('join-room', ({ room, name }) => {
    const roomName = normaliseRoomName(room);
    const displayName = (name && String(name).trim()) || 'Anon';

    if (!roomName) {
      socket.emit('room-error', 'Invalid room name');
      return;
    }

    // Leave previous room if any
    if (socket.data.room) {
      leaveCurrentRoom(socket);
    }

    let info = getRoomInfo(roomName);
    if (!info) {
      // First person to join this room becomes host
      info = rooms[roomName] = {
        ownerId: socket.id,
        locked: false,
        users: new Map(),
        streamTitle: 'Rebel Live'
      };
    } else if (info.locked && socket.id !== info.ownerId) {
      socket.emit('room-error', 'Room is locked by host');
      return;
    }

    socket.join(roomName);
    socket.data.room = roomName;
    info.users.set(socket.id, { name: displayName });

    // Tell this client its role
    socket.emit('role', {
      isHost: socket.id === info.ownerId,
      streamTitle: info.streamTitle
    });

    // Let client know it actually joined
    socket.emit('room-joined', {
      room: roomName,
      ownerId: info.ownerId
    });

    // Notify others
    socket.to(roomName).emit('user-joined', {
      id: socket.id,
      name: displayName
    });

    broadcastRoomUpdate(roomName);
  });

  // --- LOCK / UNLOCK ROOM (host only) ---
  socket.on('lock-room', (lock) => {
    const roomName = socket.data.room;
    const info = getRoomInfo(roomName);
    if (!info || socket.id !== info.ownerId) return;

    info.locked = !!lock;
    broadcastRoomUpdate(roomName);
  });

  // --- UPDATE STREAM TITLE (host only) ---
  socket.on('update-stream-title', (title) => {
    const roomName = socket.data.room;
    const info = getRoomInfo(roomName);
    if (!info || socket.id !== info.ownerId) return;

    info.streamTitle = String(title || '').slice(0, 80);
    broadcastRoomUpdate(roomName);
  });

  // --- KICK USER (host only) ---
  socket.on('kick-user', (targetId) => {
    const roomName = socket.data.room;
    const info = getRoomInfo(roomName);
    if (!info || socket.id !== info.ownerId) return;

    if (!info.users.has(targetId)) return;
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      leaveCurrentRoom(targetSocket);
    }
  });

  // --- CHAT ---
  socket.on('chat-message', ({ room, name, text }) => {
    const roomName = normaliseRoomName(room) || socket.data.room;
    const info = getRoomInfo(roomName);
    if (!info) return;

    const msg = {
      room: roomName,
      name: (name && String(name).trim()) || 'Anon',
      text: String(text || '').slice(0, 500),
      ts: Date.now()
    };

    io.to(roomName).emit('chat-message', msg);
  });

  // --- CALL SIGNALLING ---
  socket.on('ring-user', (targetId) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return;
    const info = getRoomInfo(socket.data.room);
    if (!info) return;
    const user = info.users.get(socket.id);
    const callerName = user ? user.name : 'Caller';

    targetSocket.emit('ring-alert', {
      from: callerName,
      fromId: socket.id
    });
  });

  socket.on('call-offer', ({ targetId, offer }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket || !offer) return;
    const info = getRoomInfo(socket.data.room);
    if (!info) return;
    const user = info.users.get(socket.id);
    const callerName = user ? user.name : 'Caller';

    targetSocket.emit('incoming-call', {
      from: socket.id,
      name: callerName,
      offer
    });
  });

  socket.on('call-answer', ({ targetId, answer }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket || !answer) return;

    targetSocket.emit('call-answer', {
      from: socket.id,
      answer
    });
  });

  socket.on('call-ice', ({ targetId, candidate }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket || !candidate) return;

    targetSocket.emit('call-ice', {
      from: socket.id,
      candidate
    });
  });

  socket.on('call-end', ({ targetId }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return;

    targetSocket.emit('call-end', { from: socket.id });
  });

  // --- STREAM HANDSHAKE (broadcast Host → Viewers) ---
  socket.on('webrtc-offer', ({ room, sdp }) => {
    const roomName = normaliseRoomName(room) || socket.data.room;
    if (!roomName || !sdp) return;
    socket.to(roomName).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ sdp }) => {
    const roomName = socket.data.room;
    if (!roomName || !sdp) return;
    socket.to(roomName).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    const roomName = normaliseRoomName(room) || socket.data.room;
    if (!roomName || !candidate) return;
    socket.to(roomName).emit('webrtc-ice-candidate', { candidate });
  });

  // --- LEAVE ROOM (manual) ---
  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
