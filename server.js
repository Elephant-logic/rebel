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

// --- ROOM STATE ---
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

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // --- JOIN (WITH SECURITY LOCK) ---
  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') return;

    const roomName = room.trim();
    const info = getRoomInfo(roomName);

    // SECURITY: REJECT CONNECTION IF LOCKED
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked by host');
      socket.disconnect(); // Force disconnect
      return;
    }

    const displayName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    if (!info.ownerId) info.ownerId = socket.id;
    info.users.set(socket.id, { name: displayName });

    socket.emit('role', { 
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle
    });

    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });
    broadcastRoomUpdate(roomName);
  });

  // --- HOST CONTROLS ---
  socket.on('lock-room', (locked) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return; // Only host

    info.locked = !!locked;
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

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.leave(roomName);
      targetSocket.disconnect();
    }
    info.users.delete(targetId);
    broadcastRoomUpdate(roomName);
  });

  // --- WEBRTC HANDSHAKE (DIRECT SIGNALING) ---
  // This allows the host to send a unique offer to a specific viewer
  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (targetId && sdp) {
        io.to(targetId).emit('webrtc-offer', { sdp, from: socket.id });
    }
  });

  socket.on('webrtc-answer', ({ targetId, room, sdp }) => {
    if (targetId) {
        io.to(targetId).emit('webrtc-answer', { sdp, from: socket.id });
    } else if (room) {
        // Fallback for viewers responding to host
        socket.to(room).emit('webrtc-answer', { sdp, from: socket.id });
    }
  });

  socket.on('webrtc-ice-candidate', ({ targetId, room, candidate }) => {
    if (targetId) {
        io.to(targetId).emit('webrtc-ice-candidate', { candidate, from: socket.id });
    } else if (room) {
        socket.to(room).emit('webrtc-ice-candidate', { candidate, from: socket.id });
    }
  });

  // --- CHAT CHANNELS ---
  socket.on('public-chat', ({ room, name, text, fromViewer }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    io.to(roomName).emit('public-chat', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now(),
      fromViewer: !!fromViewer
    });
  });

  socket.on('private-chat', ({ room, name, text }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    // Only people in the room (not external viewers) see this
    io.to(roomName).emit('private-chat', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now()
    });
  });

  // --- CALLING / FILES ---
  socket.on('call-offer', ({ targetId, offer }) => io.to(targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer }));
  socket.on('call-answer', ({ targetId, answer }) => io.to(targetId).emit('call-answer', { from: socket.id, answer }));
  socket.on('call-ice', ({ targetId, candidate }) => io.to(targetId).emit('call-ice', { from: socket.id, candidate }));
  socket.on('call-end', ({ targetId }) => io.to(targetId).emit('call-end', { from: socket.id }));
  socket.on('ring-user', (targetId) => io.to(targetId).emit('ring-alert', { from: socket.data.name, fromId: socket.id }));

  socket.on('file-share', ({ room, name, fileName, fileData }) => {
      const roomName = room || socket.data.room;
      if (roomName) io.to(roomName).emit('file-share', { name, fileName, fileData });
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (info) {
      info.users.delete(socket.id);
      if (info.ownerId === socket.id) { info.ownerId = null; info.locked = false; }
      socket.to(roomName).emit('user-left', { id: socket.id });
      if (info.users.size === 0) delete rooms[roomName];
      else broadcastRoomUpdate(roomName);
    }
  });
});

server.listen(PORT, () => console.log(`Rebel running on ${PORT}`));
