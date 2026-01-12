const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // 100MB limit for files
});

app.use(express.static(path.join(__dirname, 'public')));

// --- STATE ---
const rooms = Object.create(null);
const roomAliases = Object.create(null); // slug -> roomId

function getRoomInfo(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      ownerId: null,
      locked: false,
      streamTitle: 'Untitled Stream',
      publicSlug: null,
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

io.on('connection', (socket) => {
  socket.data.room = null;

  // 1. JOIN LOGIC
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    let roomName = room.trim();

    // Alias Resolution
    const aliasTarget = Object.keys(rooms).find(r => rooms[r].publicSlug === roomName);
    if (aliasTarget) roomName = aliasTarget;

    const info = getRoomInfo(roomName);

    // Lock Check
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      return socket.emit('room-error', 'Room is locked');
    }

    const displayName = (name && name.trim()) || `User-${socket.id.slice(0, 4)}`;

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    if (!info.ownerId) info.ownerId = socket.id;
    info.users.set(socket.id, { name: displayName });

    socket.emit('role', { 
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle,
      publicSlug: info.publicSlug
    });
    
    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });
    broadcastRoomUpdate(roomName);
  });

  // 2. HOST ACTIONS
  socket.on('update-stream-title', (title) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
        rooms[r].streamTitle = title;
        broadcastRoomUpdate(r);
    }
  });

  socket.on('update-public-slug', (slug) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
        const clean = slug ? slug.trim() : null;
        // Remove old
        if(rooms[r].publicSlug && roomAliases[rooms[r].publicSlug]) delete roomAliases[rooms[r].publicSlug];
        // Set new
        if(clean) roomAliases[clean] = r;
        rooms[r].publicSlug = clean;
        broadcastRoomUpdate(r);
    }
  });

  socket.on('lock-room', (val) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
        rooms[r].locked = val;
        broadcastRoomUpdate(r);
    }
  });

  socket.on('kick-user', (id) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
        io.to(id).emit('kicked');
        const s = io.sockets.sockets.get(id);
        if(s) s.leave(r);
        rooms[r].users.delete(id);
        broadcastRoomUpdate(r);
    }
  });

  // 3. STREAM HANDSHAKE (Host -> Viewers)
  // These events are specific to the one-way broadcast
  socket.on('webrtc-offer', (d) => socket.to(d.room).emit('webrtc-offer', { sdp: d.sdp }));
  socket.on('webrtc-answer', (d) => socket.to(d.room).emit('webrtc-answer', { sdp: d.sdp }));
  socket.on('webrtc-ice-candidate', (d) => socket.to(d.room).emit('webrtc-ice-candidate', { candidate: d.candidate }));

  // 4. CALL HANDSHAKE (P2P Mesh)
  // These events are specific to the video calls between users
  socket.on('ring-user', (id) => io.to(id).emit('ring-alert', { from: socket.data.name, fromId: socket.id }));
  
  socket.on('call-offer', (d) => io.to(d.targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer: d.offer }));
  socket.on('call-answer', (d) => io.to(d.targetId).emit('call-answer', { from: socket.id, answer: d.answer }));
  socket.on('call-ice', (d) => io.to(d.targetId).emit('call-ice', { from: socket.id, candidate: d.candidate }));
  socket.on('call-end', (d) => io.to(d.targetId).emit('call-end', { from: socket.id }));

  // 5. CHAT & FILES
  socket.on('chat-message', (d) => {
    if(socket.data.room) io.to(socket.data.room).emit('chat-message', { ...d, ts: Date.now() });
  });
  socket.on('file-share', (d) => {
    if(socket.data.room) io.to(socket.data.room).emit('file-share', d);
  });

  // 6. DISCONNECT
  socket.on('disconnect', () => {
    const r = socket.data.room;
    if (!r || !rooms[r]) return;

    rooms[r].users.delete(socket.id);
    socket.to(r).emit('user-left', { id: socket.id });

    // Host Transfer
    if (rooms[r].ownerId === socket.id) {
      rooms[r].ownerId = null;
      rooms[r].locked = false;
      if(rooms[r].users.size > 0) {
        const next = rooms[r].users.keys().next().value;
        rooms[r].ownerId = next;
        io.to(next).emit('role', { isHost: true, streamTitle: rooms[r].streamTitle, publicSlug: rooms[r].publicSlug });
      }
    }

    if(rooms[r].users.size === 0) {
        if(rooms[r].publicSlug) delete roomAliases[rooms[r].publicSlug];
        delete rooms[r];
    } else {
        broadcastRoomUpdate(r);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${PORT}`));
