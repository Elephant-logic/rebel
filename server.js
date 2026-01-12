const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // Allow 100MB file uploads
});

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// STATE
// ----------------------------------------------------
const rooms = Object.create(null);
const roomAliases = Object.create(null); // slug -> realRoomId

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

// ----------------------------------------------------
// SOCKET LOGIC
// ----------------------------------------------------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // --- JOIN ---
  socket.on('join-room', ({ room, name }) => {
    if (!room) return socket.emit('room-error', 'Room ID required');
    let roomName = room.trim();

    // Resolve Alias
    const aliasTarget = Object.keys(rooms).find(r => rooms[r].publicSlug === roomName);
    if (aliasTarget) roomName = aliasTarget;

    const displayName = (name && name.trim()) || `User-${socket.id.slice(0, 4)}`;
    const info = getRoomInfo(roomName);

    // Lock Check
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      return socket.emit('room-error', 'Room is locked by host');
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    // Assign Host
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

  // --- HOST ACTIONS ---
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
        // Remove old alias if needed
        const oldSlug = rooms[r].publicSlug;
        if(oldSlug && roomAliases[oldSlug]) delete roomAliases[oldSlug];
        
        // Set new
        const cleanSlug = slug ? slug.trim() : null;
        if(cleanSlug) roomAliases[cleanSlug] = r;
        
        rooms[r].publicSlug = cleanSlug;
        broadcastRoomUpdate(r);
    }
  });

  socket.on('lock-room', (locked) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
        rooms[r].locked = locked;
        broadcastRoomUpdate(r);
    }
  });

  socket.on('kick-user', (targetId) => {
     const r = socket.data.room;
     if (r && rooms[r] && rooms[r].ownerId === socket.id) {
        if (!rooms[r].users.has(targetId)) return;
        
        io.to(targetId).emit('kicked');
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) targetSocket.leave(r);
        
        rooms[r].users.delete(targetId);
        broadcastRoomUpdate(r);
     }
  });

  // --- SIGNALING (P2P CALLS) ---
  socket.on('ring-user', (targetId) => {
    io.to(targetId).emit('ring-alert', { from: socket.data.name, fromId: socket.id });
  });

  socket.on('call-offer', (d) => io.to(d.targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer: d.offer }));
  socket.on('call-answer', (d) => io.to(d.targetId).emit('call-answer', { from: socket.id, answer: d.answer }));
  socket.on('call-ice', (d) => io.to(d.targetId).emit('call-ice', { from: socket.id, candidate: d.candidate }));
  socket.on('call-end', (d) => io.to(d.targetId).emit('call-end', { from: socket.id }));

  // --- SIGNALING (STREAM) ---
  socket.on('webrtc-offer', (d) => socket.to(d.room).emit('webrtc-offer', { sdp: d.sdp }));
  socket.on('webrtc-answer', (d) => socket.to(d.room).emit('webrtc-answer', { sdp: d.sdp }));
  socket.on('webrtc-ice-candidate', (d) => socket.to(d.room).emit('webrtc-ice-candidate', { candidate: d.candidate }));

  // --- CHAT & FILES ---
  socket.on('chat-message', (d) => {
    const r = socket.data.room;
    if (r) io.to(r).emit('chat-message', { ...d, ts: Date.now() });
  });

  socket.on('file-share', (d) => {
    const r = socket.data.room;
    if (r) io.to(r).emit('file-share', d);
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const r = socket.data.room;
    if (!r || !rooms[r]) return;

    rooms[r].users.delete(socket.id);
    socket.to(r).emit('user-left', { id: socket.id });

    // Host Transfer Logic
    if (rooms[r].ownerId === socket.id) {
      rooms[r].ownerId = null;
      rooms[r].locked = false;
      
      if (rooms[r].users.size > 0) {
        const nextHost = rooms[r].users.keys().next().value;
        rooms[r].ownerId = nextHost;
        io.to(nextHost).emit('role', { 
            isHost: true, 
            streamTitle: rooms[r].streamTitle,
            publicSlug: rooms[r].publicSlug 
        });
      }
    }

    if (rooms[r].users.size === 0) {
       const slug = rooms[r].publicSlug;
       if(slug && roomAliases[slug]) delete roomAliases[slug];
       delete rooms[r];
    } else {
       broadcastRoomUpdate(r);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Rebel Server running on ${PORT}`));
