const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Simple in-memory room state
// roomName -> { hostId, locked, users: Map<socketId,{id,name}> }
const rooms = new Map();

function getOrCreateRoom(roomName, hostSocketId) {
  let room = rooms.get(roomName);
  if (!room) {
    room = {
      hostId: hostSocketId,
      locked: false,
      users: new Map()
    };
    rooms.set(roomName, room);
  }
  return room;
}

function broadcastRoomState(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;

  const users = Array.from(room.users.values());
  io.to(roomName).emit('room-state', {
    hostId: room.hostId,
    locked: room.locked,
    users
  });
}

io.on('connection', (socket) => {
  // Join room
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    let r = rooms.get(room);

    // If room exists and locked, block new non-host joins
    if (r && r.locked && r.hostId !== socket.id) {
      socket.emit('room-locked');
      return;
    }

    // Create room or get existing
    r = getOrCreateRoom(room, r?.hostId || socket.id);

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    r.users.set(socket.id, { id: socket.id, name: socket.data.name });

    // Tell others someone joined (used to trigger re-offer)
    socket.to(room).emit('user-joined', {
      id: socket.id,
      name: socket.data.name
    });

    broadcastRoomState(room);
  });

  // Host toggles room lock
  socket.on('toggle-lock', ({ room }) => {
    const roomName = room || socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r) return;

    // Only host can lock/unlock
    if (r.hostId !== socket.id) return;

    r.locked = !r.locked;
    broadcastRoomState(roomName);
  });

  // Relay WebRTC signalling
  socket.on('webrtc-offer', (data) => {
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-offer', { sdp: data.sdp });
  });

  socket.on('webrtc-answer', (data) => {
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-answer', { sdp: data.sdp });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    if (!data || !data.room || !data.candidate) return;
    socket.to(data.room).emit('webrtc-ice-candidate', {
      candidate: data.candidate
    });
  });

  // Chat relay (host & viewers)
  socket.on('chat-message', (data) => {
    if (!data || !data.room || !data.text) return;
    socket.to(data.room).emit('chat-message', {
      name: data.name || 'Anon',
      text: data.text,
      ts: Date.now()
    });
  });

  // File relay
  socket.on('file-share', (data) => {
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const r = rooms.get(roomName);
    if (!r) return;

    r.users.delete(socket.id);

    // If host left, promote first remaining user as host
    if (r.hostId === socket.id) {
      const first = r.users.keys().next();
      r.hostId = first.done ? null : first.value;
    }

    if (r.users.size === 0) {
      rooms.delete(roomName);
    } else {
      socket.to(roomName).emit('user-left', { id: socket.id });
      broadcastRoomState(roomName);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
