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
// State
// ----------------------------------------------------
const rooms = Object.create(null);
const roomAliases = Object.create(null); // Map: "public-slug" -> "real-room-id"

function getRoomInfo(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      ownerId: null,
      locked: false,
      streamTitle: 'Untitled Stream',
      publicSlug: null, // Track the active alias
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
    streamTitle: room.streamTitle,
    publicSlug: room.publicSlug
  });
}

// ----------------------------------------------------
// Socket.io
// ----------------------------------------------------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // --- JOIN (Updated for Aliases) ---
  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') {
      socket.emit('room-error', 'Invalid room');
      return;
    }

    let roomName = room.trim();
    
    // 1. Check if this is an alias for another room
    if (roomAliases[roomName]) {
      roomName = roomAliases[roomName];
    }

    const displayName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;
    const info = getRoomInfo(roomName);

    // Respect lock (Host can always re-join)
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked by host');
      return;
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    // First user becomes host
    if (!info.ownerId) {
      info.ownerId = socket.id;
    }

    info.users.set(socket.id, { name: displayName });

    // Tell client their role & current alias
    socket.emit('role', { 
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle,
      publicSlug: info.publicSlug
    });

    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });

    broadcastRoomUpdate(roomName);
  });

  // --- HOST: Update Public Link Name (Slug) ---
  socket.on('update-public-slug', (slug) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    
    // 1. Auth Check
    if (!info || info.ownerId !== socket.id) return socket.emit('room-error', 'Host only');

    const newSlug = slug ? slug.trim() : null;

    // 2. Clear old alias if exists
    if (info.publicSlug && roomAliases[info.publicSlug] === roomName) {
      delete roomAliases[info.publicSlug];
    }

    // 3. Set new alias
    if (newSlug) {
      // Check collision
      if (roomAliases[newSlug] || rooms[newSlug]) {
        return socket.emit('room-error', 'Link name already taken');
      }
      roomAliases[newSlug] = roomName;
    }

    info.publicSlug = newSlug;
    broadcastRoomUpdate(roomName);
  });

  // --- STANDARD HOST ACTIONS ---
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
    }
    info.users.delete(targetId);
    broadcastRoomUpdate(roomName);
  });

  // --- SIGNALING ---
  const signal = (event, data) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    if (data.targetId) {
        io.to(data.targetId).emit(event, { ...data, from: socket.id });
    } else {
        socket.to(roomName).emit(event, { ...data, from: socket.id });
    }
  };

  socket.on('webrtc-offer', (d) => signal('webrtc-offer', d));
  socket.on('webrtc-answer', (d) => signal('webrtc-answer', d));
  socket.on('webrtc-ice-candidate', (d) => signal('webrtc-ice-candidate', d));

  socket.on('call-offer', (d) => io.to(d.targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer: d.offer }));
  socket.on('call-answer', (d) => io.to(d.targetId).emit('call-answer', { from: socket.id, answer: d.answer }));
  socket.on('call-ice', (d) => io.to(d.targetId).emit('call-ice', { from: socket.id, candidate: d.candidate }));
  socket.on('call-end', (d) => io.to(d.targetId).emit('call-end', { from: socket.id }));
  socket.on('ring-user', (id) => io.to(id).emit('ring-alert', { from: socket.data.name, fromId: socket.id }));

  socket.on('chat-message', ({ room, name, text, fromViewer }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    const info = rooms[roomName];
    io.to(roomName).emit('chat-message', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now(),
      isOwner: info && info.ownerId === socket.id,
      fromViewer: !!fromViewer
    });
  });

  socket.on('file-share', ({ room, name, fileName, fileType, fileData }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !fileName || !fileData) return;
    io.to(roomName).emit('file-share', { name: name || socket.data.name, fileName, fileType, fileData });
  });

  // --- DISCONNECT (With Alias Cleanup & Host Pass-on) ---
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const info = rooms[roomName];
    if (!info) return;

    info.users.delete(socket.id);
    socket.to(roomName).emit('user-left', { id: socket.id });

    if (info.ownerId === socket.id) {
      info.ownerId = null;
      info.locked = false;

      // Pass Host Role
      if (info.users.size > 0) {
        const newHostId = info.users.keys().next().value;
        info.ownerId = newHostId;
        const newHostSocket = io.sockets.sockets.get(newHostId);
        if (newHostSocket) {
          newHostSocket.emit('role', { 
            isHost: true, 
            streamTitle: info.streamTitle,
            publicSlug: info.publicSlug 
          });
        }
      }
    }

    if (info.users.size === 0) {
      // Clean up Alias if exists
      if (info.publicSlug && roomAliases[info.publicSlug] === roomName) {
        delete roomAliases[info.publicSlug];
      }
      delete rooms[roomName];
    } else {
      broadcastRoomUpdate(roomName);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
