const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// -----------------------
// ROOM STATE
// -----------------------

const rooms = {}; // { roomName: { host: socketId, locked: bool, users: Set<socketId> } }

// -----------------------
// STATIC FILES
// -----------------------
app.use(express.static(path.join(__dirname, 'public')));

// VIEWER ROUTE (OPTIONAL)
app.get('/view', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

// -----------------------
// SOCKET HANDLING
// -----------------------
io.on('connection', (socket) => {

  socket.on('join-room', ({ room, name }) => {
    if (!rooms[room]) {
      rooms[room] = { host: socket.id, locked: false, users: new Set() };
    }

    const roomInfo = rooms[room];

    // Check locked
    if (roomInfo.locked && roomInfo.host !== socket.id) {
      socket.emit('room-locked');
      return;
    }

    // Track membership
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || `User-${socket.id.slice(0,4)}`;

    roomInfo.users.add(socket.id);

    // Tell user if they are host
    socket.emit('role', { isHost: roomInfo.host === socket.id });

    // Update everyone
    broadcastRoomUpdate(room);
  });

  const broadcastRoomUpdate = (room) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    const payload = {
      host: roomInfo.host,
      locked: roomInfo.locked,
      users: Array.from(roomInfo.users).map(id => ({
        id,
        name: io.sockets.sockets.get(id)?.data.name || `User-${id.slice(0,4)}`
      }))
    };

    io.to(room).emit('room-update', payload);
  };

  // -----------------------
  // STREAM SIGNALING
  // -----------------------
  socket.on('webrtc-offer', ({ room, sdp }) => {
    socket.to(room).emit('webrtc-offer', { from: socket.id, sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    socket.to(room).emit('webrtc-answer', { from: socket.id, sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    socket.to(room).emit('webrtc-ice-candidate', { from: socket.id, candidate });
  });

  // -----------------------
  // CALL SIGNALING (MESH)
  // -----------------------
  socket.on('call-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('incoming-call', {
      from: socket.id,
      name: socket.data.name,
      offer
    });
  });

  socket.on('call-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('call-answer', {
      from: socket.id,
      answer
    });
  });

  socket.on('call-ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('call-ice', {
      from: socket.id,
      candidate
    });
  });

  socket.on('call-reject', ({ targetId }) => {
    io.to(targetId).emit('call-reject', {
      from: socket.id
    });
  });

  socket.on('call-end', ({ targetId }) => {
    io.to(targetId).emit('call-end', {
      from: socket.id
    });
  });

  socket.on('call-hangup-all', () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    const roomInfo = rooms[room];
    if (roomInfo.host !== socket.id) return; // only host can hangup all

    for (const uid of roomInfo.users) {
      if (uid !== socket.id) {
        io.to(uid).emit('call-end', { from: socket.id });
      }
    }
  });

  // -----------------------
  // LOCK / UNLOCK ROOM
  // -----------------------
  socket.on('lock-room', () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    if (rooms[room].host !== socket.id) return;

    rooms[room].locked = true;
    broadcastRoomUpdate(room);
  });

  socket.on('unlock-room', () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    if (rooms[room].host !== socket.id) return;

    rooms[room].locked = false;
    broadcastRoomUpdate(room);
  });

  // -----------------------
  // CHAT
  // -----------------------
  socket.on('chat-message', ({ room, text }) => {
    io.to(room).emit('chat-message', {
      from: socket.data.name,
      text
    });
  });

  // -----------------------
  // FILE SHARE
  // -----------------------
  socket.on('file-share', ({ room, filename, dataUrl }) => {
    io.to(room).emit('file-share', {
      from: socket.data.name,
      filename,
      dataUrl
    });
  });

  // -----------------------
  // DISCONNECT
  // -----------------------
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;

    const roomInfo = rooms[room];
    roomInfo.users.delete(socket.id);

    // Rehost logic (optional) — for now, host remains fixed unless leaves
    if (socket.id === roomInfo.host) {
      // If host leaves, unlock and keep room open
      roomInfo.locked = false;
    }

    broadcastRoomUpdate(room);
  });

});

// -----------------------
server.listen(9100, () => {
  console.log('Server running on port 9100');
});
