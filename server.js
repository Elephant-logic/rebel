const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);

// FIX: Increased buffer to 50MB for large arcade transfers and tight timeouts
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e7, 
  pingTimeout: 10000,     
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

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

  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') return;

    const roomName = room.trim().slice(0, 50); 
    const displayName = (name && String(name).trim() || `User-${socket.id.slice(0, 4)}`).slice(0, 30); 

    const info = getRoomInfo(roomName);

    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked');
      socket.disconnect();
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

  // STRICT AUTHORITY: Manual promotion only
  socket.on('promote-to-host', ({ targetId }) => {
    const roomName = socket.data.room;
    const info = rooms[roomName];
    if (info && info.ownerId === socket.id) {
        info.ownerId = targetId;
        socket.emit('role', { isHost: false });
        const nextSocket = io.sockets.sockets.get(targetId);
        if (nextSocket) nextSocket.emit('role', { isHost: true, streamTitle: info.streamTitle });
        broadcastRoomUpdate(roomName);
    }
  });

  socket.on('lock-room', (locked) => {
    const info = rooms[socket.data.room];
    if (info && info.ownerId === socket.id) {
      info.locked = !!locked;
      broadcastRoomUpdate(socket.data.room);
    }
  });

  socket.on('update-stream-title', (title) => {
    const info = rooms[socket.data.room];
    if (info && info.ownerId === socket.id) {
      info.streamTitle = title.slice(0, 100);
      broadcastRoomUpdate(socket.data.room);
    }
  });

  socket.on('kick-user', (targetId) => {
    const info = rooms[socket.data.room];
    if (info && info.ownerId === socket.id) {
      const target = io.sockets.sockets.get(targetId);
      if (target) {
        target.emit('kicked');
        target.disconnect();
      }
    }
  });

  // Signaling & Chat
  socket.on('webrtc-offer', (d) => io.to(d.targetId).emit('webrtc-offer', { sdp: d.sdp, from: socket.id }));
  socket.on('webrtc-answer', (d) => io.to(d.targetId).emit('webrtc-answer', { sdp: d.sdp, from: socket.id }));
  socket.on('webrtc-ice-candidate', (d) => io.to(d.targetId).emit('webrtc-ice-candidate', { candidate: d.candidate, from: socket.id }));

  socket.on('ring-user', (id) => io.to(id).emit('ring-alert', { from: socket.data.name, fromId: socket.id }));
  socket.on('call-offer', (d) => io.to(d.targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer: d.offer }));
  socket.on('call-answer', (d) => io.to(d.targetId).emit('call-answer', { from: socket.id, answer: d.answer }));
  socket.on('call-ice', (d) => io.to(d.targetId).emit('call-ice', { from: socket.id, candidate: d.candidate }));
  socket.on('call-end', (d) => io.to(d.targetId).emit('call-end', { from: socket.id }));

  socket.on('public-chat', (d) => {
    io.to(d.room).emit('public-chat', { name: d.name, text: d.text, ts: Date.now() });
  });

  socket.on('private-chat', (d) => {
    io.to(d.room).emit('private-chat', { name: d.name, text: d.text, ts: Date.now() });
  });

  socket.on('file-share', (d) => {
    io.to(d.room).emit('file-share', { name: d.name, fileName: d.fileName, fileData: d.fileData });
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info) return;

    info.users.delete(socket.id);
    
    // PATCH: Remove Auto-Migration Logic. If host leaves, ownerId becomes null.
    if (info.ownerId === socket.id) {
      info.ownerId = null;
    }

    socket.to(roomName).emit('user-left', { id: socket.id });
    if (info.users.size === 0) delete rooms[roomName];
    else broadcastRoomUpdate(roomName);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${PORT}`));
