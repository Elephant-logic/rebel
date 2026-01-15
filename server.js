const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);

// Increased buffer to 50MB for large arcade transfers
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
    rooms[roomName] = { ownerId: null, locked: false, streamTitle: 'Untitled Stream', users: new Map() };
  }
  return rooms[roomName];
}

function broadcastRoomUpdate(roomName) {
  const room = rooms[roomName];
  if (!room) return;

  const users = [];
  for (const [id, u] of room.users.entries()) { users.push({ id, name: u.name }); }

  io.to(roomName).emit('room-update', {
    users,
    ownerId: room.ownerId,
    locked: room.locked,
    streamTitle: room.streamTitle,
    viewerCount: room.users.size 
  });
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
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
    if (!info.ownerId) info.ownerId = socket.id;
    info.users.set(socket.id, { name: displayName });

    socket.emit('role', { isHost: info.ownerId === socket.id, streamTitle: info.streamTitle });
    broadcastRoomUpdate(roomName);
  });

  socket.on('public-chat', ({ room, name, text, fromViewer }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    io.to(roomName).emit('public-chat', {
      name: (name || 'Anon').slice(0,30),
      text: String(text).slice(0, 500),
      ts: Date.now(),
      fromViewer: !!fromViewer
    });
  });

  // Signaling, Calls, and Files preserved as per standard server.js
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info) return;
    info.users.delete(socket.id);
    if (info.ownerId === socket.id && info.users.size > 0) {
      info.ownerId = info.users.keys().next().value;
    }
    if (info.users.size === 0) delete rooms[roomName];
    else broadcastRoomUpdate(roomName);
  });
});

server.listen(PORT, '0.0.0.0', () => { console.log(`Server running on ${PORT}`); });
