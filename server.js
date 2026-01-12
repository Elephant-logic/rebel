const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // 100 MB Limit for file sharing
});

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------
// DATA STRUCTURES
// ----------------------------------------------------------------------
const rooms = Object.create(null);
const roomAliases = Object.create(null); // Map <Slug> -> <RoomID>

function getRoomInfo(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      ownerId: null,
      locked: false,
      streamTitle: 'Untitled Stream',
      publicSlug: null,
      users: new Map() // socketId -> { name }
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

// ----------------------------------------------------------------------
// SOCKET LOGIC
// ----------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // --- JOIN ROOM ---
  socket.on('join-room', ({ room, name }) => {
    if (!room) return socket.emit('room-error', 'Room ID required');
    let roomName = room.trim();

    // Check if user joined via Slug (Alias)
    const aliasTarget = Object.keys(rooms).find(r => rooms[r].publicSlug === roomName);
    if (aliasTarget) {
      roomName = aliasTarget;
    }

    const info = getRoomInfo(roomName);

    // Locked Check
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      return socket.emit('room-error', 'Room is locked by host.');
    }

    const displayName = (name && name.trim()) || `User-${socket.id.slice(0, 4)}`;

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    // Assign Host if room is new or empty
    if (!info.ownerId) {
      info.ownerId = socket.id;
    }

    info.users.set(socket.id, { name: displayName });

    // Send Role to user
    socket.emit('role', {
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle,
      publicSlug: info.publicSlug
    });

    // Notify others
    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });
    
    // Update everyone's UI
    broadcastRoomUpdate(roomName);
  });

  // --- HOST CONTROLS ---
  socket.on('update-stream-title', (title) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
      rooms[r].streamTitle = title || 'Untitled';
      broadcastRoomUpdate(r);
    }
  });

  socket.on('update-public-slug', (slug) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
      // Remove old alias
      const old = rooms[r].publicSlug;
      if (old && roomAliases[old]) delete roomAliases[old];

      // Set new alias
      const clean = slug ? slug.trim() : null;
      if (clean) {
        // Simple collision check could go here
        roomAliases[clean] = r;
      }
      rooms[r].publicSlug = clean;
      broadcastRoomUpdate(r);
    }
  });

  socket.on('lock-room', (isLocked) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
      rooms[r].locked = !!isLocked;
      broadcastRoomUpdate(r);
    }
  });

  socket.on('kick-user', (targetId) => {
    const r = socket.data.room;
    if (r && rooms[r] && rooms[r].ownerId === socket.id) {
      if (!rooms[r].users.has(targetId)) return;
      
      io.to(targetId).emit('kicked');
      const s = io.sockets.sockets.get(targetId);
      if (s) {
        s.leave(r);
        s.data.room = null;
      }
      rooms[r].users.delete(targetId);
      broadcastRoomUpdate(r);
    }
  });

  // --- STREAM SIGNALING (Host -> Viewers) ---
  socket.on('webrtc-offer', (data) => {
    // Broadcast offer to everyone in room (Viewers)
    const r = socket.data.room;
    if (r) socket.to(r).emit('webrtc-offer', { sdp: data.sdp });
  });

  socket.on('webrtc-answer', (data) => {
    // Viewers send answer back to Host
    // In a simple broadcast scenario, we send it to everyone, 
    // but really only the Host needs it. 
    const r = socket.data.room;
    if (r) socket.to(r).emit('webrtc-answer', { sdp: data.sdp, from: socket.id });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    const r = socket.data.room;
    if (r) socket.to(r).emit('webrtc-ice-candidate', { candidate: data.candidate, from: socket.id });
  });

  // --- P2P CALL SIGNALING (Mesh Network) ---
  socket.on('ring-user', (targetId) => {
    io.to(targetId).emit('ring-alert', { from: socket.data.name, fromId: socket.id });
  });

  socket.on('call-offer', (d) => {
    io.to(d.targetId).emit('incoming-call', {
      from: socket.id,
      name: socket.data.name,
      offer: d.offer
    });
  });

  socket.on('call-answer', (d) => {
    io.to(d.targetId).emit('call-answer', {
      from: socket.id,
      answer: d.answer
    });
  });

  socket.on('call-ice', (d) => {
    io.to(d.targetId).emit('call-ice', {
      from: socket.id,
      candidate: d.candidate
    });
  });

  socket.on('call-end', (d) => {
    io.to(d.targetId).emit('call-end', { from: socket.id });
  });

  // --- CHAT & FILES ---
  socket.on('chat-message', (data) => {
    const r = socket.data.room;
    if (r) {
      const info = rooms[r];
      io.to(r).emit('chat-message', {
        name: data.name,
        text: data.text,
        ts: Date.now(),
        isOwner: info && info.ownerId === socket.id,
        fromViewer: !!data.fromViewer
      });
    }
  });

  socket.on('file-share', (data) => {
    const r = socket.data.room;
    if (r) io.to(r).emit('file-share', data);
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const r = socket.data.room;
    if (!r || !rooms[r]) return;

    rooms[r].users.delete(socket.id);
    socket.to(r).emit('user-left', { id: socket.id });

    // Host Migration (Pass the Torch)
    if (rooms[r].ownerId === socket.id) {
      rooms[r].ownerId = null;
      rooms[r].locked = false; // unlock on host leave

      if (rooms[r].users.size > 0) {
        // Assign new host (first user in map)
        const nextHostId = rooms[r].users.keys().next().value;
        rooms[r].ownerId = nextHostId;
        
        io.to(nextHostId).emit('role', {
          isHost: true,
          streamTitle: rooms[r].streamTitle,
          publicSlug: rooms[r].publicSlug
        });
      }
    }

    if (rooms[r].users.size === 0) {
      // Cleanup Room & Alias
      const slug = rooms[r].publicSlug;
      if (slug && roomAliases[slug]) delete roomAliases[slug];
      delete rooms[r];
    } else {
      broadcastRoomUpdate(r);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel Server Running on Port ${PORT}`);
});
