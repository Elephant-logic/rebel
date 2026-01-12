const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve the public folder
app.use(express.static(path.join(__dirname, 'public')));

// ------- ROOM STATE (host, lock, users) -------

/**
 * rooms: Map<roomName, {
 *   hostId: string,
 *   locked: boolean,
 *   users: Map<socketId, name>
 * }>
 */
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

function broadcastRoomState(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;

  const users = Array.from(room.users.entries()).map(([id, name]) => ({
    id,
    name: name || 'Anon'
  }));

  io.to(roomName).emit('room-state', {
    room: roomName,
    hostId: room.hostId,
    locked: room.locked,
    users
  });
}

// ------- SOCKET.IO -------

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = 'Anon';

  // Join room
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    const roomName = room.trim();
    const displayName = (name && name.trim()) || 'Anon';

    const r = getOrCreateRoom(roomName);

    // If locked and this socket is not already in
    if (r.locked && !r.users.has(socket.id)) {
      socket.emit('room-locked', { room: roomName });
      return;
    }

    // Leave previous room if different
    if (socket.data.room && socket.data.room !== roomName) {
      socket.leave(socket.data.room);
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    r.users.set(socket.id, displayName);
    if (!r.hostId) {
      r.hostId = socket.id; // first in becomes host
    }

    // Tell others someone joined (used by host to re-offer stream)
    socket.to(roomName).emit('user-joined', {
      id: socket.id,
      name: displayName
    });

    broadcastRoomState(roomName);
  });

  // Host toggles lock
  socket.on('toggle-lock', ({ room }) => {
    if (!room) return;
    const r = rooms.get(room);
    if (!r) return;
    if (r.hostId !== socket.id) return; // only host can lock/unlock

    r.locked = !r.locked;
    broadcastRoomState(room);
  });

  // WebRTC signalling
  socket.on('webrtc-offer', (data) => {
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-offer', {
      room: data.room,
      sdp: data.sdp
    });
  });

  socket.on('webrtc-answer', (data) => {
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-answer', {
      room: data.room,
      sdp: data.sdp
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    if (!data || !data.room || !data.candidate) return;
    socket.to(data.room).emit('webrtc-ice-candidate', {
      room: data.room,
      candidate: data.candidate
    });
  });

  // Chat – send to EVERYONE in the room, with senderId, so
  // host & joiner both see messages and we can mark "You"
  socket.on('chat-message', (data) => {
    if (!data || !data.room || !data.text) return;
    const roomName = data.room;
    const r = rooms.get(roomName);
    if (!r) return;

    const payload = {
      room: roomName,
      name: data.name || r.users.get(socket.id) || 'Anon',
      text: data.text,
      ts: Date.now(),
      senderId: socket.id
    };

    io.to(roomName).emit('chat-message', payload);
  });

  // Files – just relay to others (host keeps local "You" label)
  socket.on('file-share', (data) => {
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const r = rooms.get(roomName);
    if (!r) return;

    r.users.delete(socket.id);

    // If host left, move host to first remaining user
    if (r.hostId === socket.id) {
      const firstUser = r.users.keys().next();
      r.hostId = firstUser.done ? null : firstUser.value;
    }

    // Clean up empty room
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
