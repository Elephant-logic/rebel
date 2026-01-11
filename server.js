const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

/**
 * rooms = Map<roomName, {
 *   hostId: string,
 *   locked: boolean,
 *   users: Map<socketId, { id, name }>,
 * }>
 */
const rooms = new Map();

function createRoom(room, hostId, name) {
  const data = {
    hostId,
    locked: false,
    users: new Map()
  };
  data.users.set(hostId, { id: hostId, name });
  rooms.set(room, data);
  return data;
}

function broadcastRoom(room) {
  const r = rooms.get(room);
  if (!r) return;
  io.to(room).emit('room-state', {
    hostId: r.hostId,
    locked: r.locked,
    users: Array.from(r.users.values())
  });
}

io.on('connection', (socket) => {

  socket.on('join-room', ({ room, name }) => {
    if (!room) return;

    let r = rooms.get(room);
    if (r && r.locked && r.hostId !== socket.id) {
      socket.emit('room-locked');
      return;
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    if (!r) {
      r = createRoom(room, socket.id, name);
    } else {
      r.users.set(socket.id, { id: socket.id, name });
    }

    io.to(room).emit('user-joined', { id: socket.id, name });
    broadcastRoom(room);
  });

  socket.on('toggle-lock', () => {
    const room = socket.data.room;
    if (!room) return;
    const r = rooms.get(room);
    if (!r) return;
    if (r.hostId !== socket.id) return;
    r.locked = !r.locked;
    broadcastRoom(room);
  });

  // host → user ring
  socket.on('call-user', ({ to }) => {
    const room = socket.data.room;
    const fromName = socket.data.name;
    io.to(to).emit('incoming-call', {
      from: socket.id,
      fromName
    });
  });

  // user → host accept or reject
  socket.on('call-response', ({ to, accepted }) => {
    io.to(to).emit('call-response', {
      from: socket.id,
      accepted
    });
  });

  // chat relay
  socket.on('chat-message', ({ room, name, text, ts }) => {
    socket.to(room).emit('chat-message', { name, text, ts });
  });

  // file relay
  socket.on('file-share', (data) => {
    const room = data.room;
    socket.to(room).emit('file-share', data);
  });

  // webrtc
  socket.on('webrtc-offer', ({ room, sdp }) => {
    socket.to(room).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    socket.to(room).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    socket.to(room).emit('webrtc-ice-candidate', { candidate });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room) return;
    const r = rooms.get(room);
    if (!r) return;

    r.users.delete(socket.id);

    if (r.hostId === socket.id) {
      const next = r.users.keys().next();
      if (!next.done) {
        r.hostId = next.value;
      } else {
        rooms.delete(room);
        return;
      }
    }

    socket.to(room).emit('user-left', { id: socket.id });
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log('Rebel server running on port', PORT);
});
