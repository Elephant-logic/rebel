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

// Static files live in ./public (index.html, view.html, app.js, viewer.js, style.css, etc.)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/view.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'view.html'));
});

/**
 * Room state:
 * rooms = {
 *   [roomName]: {
 *     ownerId: 'socketId',
 *     locked: false,
 *     users: Map<socketId, { id, name }>
 *   }
 * }
 */
const rooms = new Map();

function getRoom(roomName) {
  let r = rooms.get(roomName);
  if (!r) {
    r = { ownerId: null, locked: false, users: new Map() };
    rooms.set(roomName, r);
  }
  return r;
}

function broadcastRoomUpdate(roomName) {
  const r = rooms.get(roomName);
  if (!r) return;
  const users = Array.from(r.users.values());
  io.to(roomName).emit('room-update', {
    users,
    ownerId: r.ownerId,
    locked: r.locked
  });
}

io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);

  // JOIN ROOM (host UI and viewers both use this)
  socket.on('join-room', ({ room, name }) => {
    room = (room || '').trim();
    if (!room) return;

    const r = getRoom(room);

    if (r.locked && !r.users.has(socket.id)) {
      socket.emit('room-error', 'Room is locked.');
      return;
    }

    const displayName = name && name.trim()
      ? name.trim()
      : `Guest-${Math.floor(Math.random() * 1000)}`;

    socket.join(room);
    socket.data.room = room;
    socket.data.name = displayName;

    if (!r.ownerId) {
      r.ownerId = socket.id;
    }

    r.users.set(socket.id, { id: socket.id, name: displayName });

    // tell this client if it is host
    socket.emit('role', { isHost: socket.id === r.ownerId });

    // update everyone
    broadcastRoomUpdate(room);

    // announce join
    socket.to(room).emit('user-joined', { id: socket.id, name: displayName });
  });

  // LOCK / UNLOCK ROOM (host only)
  socket.on('lock-room', (locked) => {
    const room = socket.data.room;
    if (!room) return;
    const r = rooms.get(room);
    if (!r || r.ownerId !== socket.id) return;
    r.locked = !!locked;
    broadcastRoomUpdate(room);
  });

  // KICK USER (host only)
  socket.on('kick-user', (targetId) => {
    const room = socket.data.room;
    if (!room) return;
    const r = rooms.get(room);
    if (!r || r.ownerId !== socket.id) return;
    if (!r.users.has(targetId)) return;

    io.to(targetId).emit('kicked');

    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.leave(room);
      target.disconnect(true);
    }

    r.users.delete(targetId);
    broadcastRoomUpdate(room);
  });

  // CHAT (room + viewer chat share same event)
  socket.on('chat-message', ({ text, fromViewer }) => {
    const room = socket.data.room;
    if (!room) return;
    const r = rooms.get(room);
    const isOwner = r && socket.id === r.ownerId;
    const name = socket.data.name || 'User';

    io.to(room).emit('chat-message', {
      name,
      text,
      ts: Date.now(),
      isOwner,
      fromViewer: !!fromViewer
    });
  });

  // FILE SHARE
  socket.on('file-share', (payload) => {
    const room = socket.data.room;
    if (!room) return;
    io.to(room).emit('file-share', payload);
  });

  // ========= STREAM (host → viewers) =========
  // Host sends offer to everyone else in room
  socket.on('webrtc-offer', ({ sdp, room }) => {
    const rName = room || socket.data.room;
    if (!rName) return;
    socket.to(rName).emit('webrtc-offer', { sdp });
  });

  // Viewer sends answer back to host only
  socket.on('webrtc-answer', ({ sdp }) => {
    const room = socket.data.room;
    if (!room) return;
    const r = rooms.get(room);
    if (!r || !r.ownerId) return;
    io.to(r.ownerId).emit('webrtc-answer', { sdp });
  });

  // ICE from host <-> viewers
  socket.on('webrtc-ice-candidate', ({ candidate }) => {
    const room = socket.data.room;
    if (!room) return;
    const r = rooms.get(room);
    if (!r || !r.ownerId) return;

    if (socket.id === r.ownerId) {
      // host → all viewers
      socket.to(room).emit('webrtc-ice-candidate', { candidate });
    } else {
      // viewer → host
      io.to(r.ownerId).emit('webrtc-ice-candidate', { candidate });
    }
  });

  // ========= CALLS (multi-call) =========

  // Send a ring notification
  socket.on('ring-user', (targetId) => {
    const name = socket.data.name || 'User';
    io.to(targetId).emit('ring-alert', { from: name });
  });

  // Call offer
  socket.on('call-offer', ({ targetId, offer }) => {
    const name = socket.data.name || 'User';
    io.to(targetId).emit('incoming-call', {
      from: socket.id,
      name,
      offer
    });
  });

  // Call answer
  socket.on('call-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('call-answer', {
      from: socket.id,
      answer
    });
  });

  // Call ICE
  socket.on('call-ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('call-ice', {
      from: socket.id,
      candidate
    });
  });

  // Call end
  socket.on('call-end', ({ targetId }) => {
    io.to(targetId).emit('call-end', { from: socket.id });
  });

  // Call reject
  socket.on('call-reject', ({ targetId }) => {
    io.to(targetId).emit('call-reject', { from: socket.id });
  });

  // ========= DISCONNECT =========
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room) return;

    const r = rooms.get(room);
    if (!r) return;

    r.users.delete(socket.id);

    // if host left, move crown to next user
    if (r.ownerId === socket.id) {
      const iter = r.users.keys();
      const next = iter.next();
      r.ownerId = next.done ? null : next.value;
      if (r.ownerId) {
        io.to(r.ownerId).emit('role', { isHost: true });
      }
    }

    // notify others someone left
    socket.to(room).emit('user-left', { id: socket.id });
    broadcastRoomUpdate(room);

    if (r.users.size === 0) {
      rooms.delete(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
