const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// --- ROOMS ---
const rooms = {};

function getRoom(name) {
  if (!rooms[name]) {
    rooms[name] = { owner: null, locked: false, title: 'Untitled', users: new Set() };
  }
  return rooms[name];
}

function updateRoom(roomName) {
  const r = rooms[roomName];
  if (!r) return;
  const userList = Array.from(r.users).map(id => ({ 
    id, 
    name: io.sockets.sockets.get(id)?.data.name || 'User' 
  }));
  io.to(roomName).emit('room-update', { 
    users: userList, 
    owner: r.owner, 
    locked: r.locked, 
    title: r.title 
  });
}

io.on('connection', (socket) => {
  // JOIN
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    const r = getRoom(room);
    
    // Security: Lock check
    if (r.locked && r.owner && r.owner !== socket.id) {
      socket.emit('room-error', 'Room Locked');
      socket.disconnect();
      return;
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || `User-${socket.id.substr(0,4)}`;
    r.users.add(socket.id);

    // First user becomes Host
    if (!r.owner) r.owner = socket.id;

    socket.emit('role', { isHost: r.owner === socket.id, title: r.title });
    socket.to(room).emit('user-joined', { id: socket.id, name: socket.data.name });
    updateRoom(room);
  });

  // HOST COMMANDS
  socket.on('lock-room', (val) => {
    const r = rooms[socket.data.room];
    if (r && r.owner === socket.id) { r.locked = val; updateRoom(socket.data.room); }
  });
  
  socket.on('kick-user', (id) => {
    const r = rooms[socket.data.room];
    if (r && r.owner === socket.id) {
      io.to(id).emit('kicked');
      io.sockets.sockets.get(id)?.disconnect();
    }
  });

  socket.on('update-title', (t) => {
    const r = rooms[socket.data.room];
    if (r && r.owner === socket.id) { r.title = t; updateRoom(socket.data.room); }
  });

  // SIGNALS (Direct & Broadcast)
  socket.on('webrtc-offer', ({ target, sdp }) => io.to(target).emit('webrtc-offer', { sdp, from: socket.id }));
  socket.on('webrtc-answer', ({ target, sdp }) => io.to(target).emit('webrtc-answer', { sdp, from: socket.id }));
  socket.on('webrtc-ice', ({ target, candidate }) => io.to(target).emit('webrtc-ice', { candidate, from: socket.id }));

  socket.on('call-offer', ({ target, offer }) => io.to(target).emit('call-offer', { offer, from: socket.id, name: socket.data.name }));
  socket.on('call-answer', ({ target, answer }) => io.to(target).emit('call-answer', { answer, from: socket.id }));
  socket.on('call-ice', ({ target, candidate }) => io.to(target).emit('call-ice', { candidate, from: socket.id }));
  socket.on('call-end', ({ target }) => io.to(target).emit('call-end', { from: socket.id }));

  // CHAT
  socket.on('chat', (data) => io.to(data.room).emit('chat', { ...data, ts: Date.now() }));
  socket.on('file', (data) => io.to(data.room).emit('file', data));

  // LEAVE
  socket.on('disconnect', () => {
    const rName = socket.data.room;
    if (rName && rooms[rName]) {
      const r = rooms[rName];
      r.users.delete(socket.id);
      socket.to(rName).emit('user-left', { id: socket.id });
      
      if (r.owner === socket.id) {
        r.owner = null;
        r.locked = false;
        if (r.users.size > 0) {
          r.owner = r.users.values().next().value; // Promote next user
          io.to(r.owner).emit('role', { isHost: true, title: r.title });
        }
      }
      if (r.users.size === 0) delete rooms[rName];
      else updateRoom(rName);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
