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

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// In-memory room state
// ----------------------------------------------------
const rooms = Object.create(null);

function getRoomInfo(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      ownerId: null,
      locked: false,
      streamTitle: 'Untitled Stream', 
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
    streamTitle: room.streamTitle
  });
}

// ----------------------------------------------------
// Socket.io Events
// ----------------------------------------------------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // --- JOIN ROOM ---
  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') {
      socket.emit('room-error', 'Invalid room');
      return;
    }

    const roomName = room.trim();
    const info = getRoomInfo(roomName);

    // SECURITY: If locked and user is not the owner, reject
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked by host');
      socket.disconnect();
      return;
    }

    const displayName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    // If room has no owner, this user becomes Host
    if (!info.ownerId) {
      info.ownerId = socket.id;
    }

    info.users.set(socket.id, { name: displayName });

    // Tell the user their role
    socket.emit('role', { 
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle
    });

    // Notify others
    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });
    
    // Update everyone's user list
    broadcastRoomUpdate(roomName);
  });

  // --- HOST CONTROLS ---
  socket.on('lock-room', (locked) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    // Only allow if user is Host
    if (!info || info.ownerId !== socket.id) return;

    info.locked = !!locked;
    broadcastRoomUpdate(roomName);
  });

  socket.on('update-stream-title', (title) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    info.streamTitle = title || 'Untitled Stream';
    broadcastRoomUpdate(roomName);
  });

  socket.on('kick-user', (targetId) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    // Disconnect the target
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.leave(roomName);
      targetSocket.disconnect();
    }
    
    info.users.delete(targetId);
    broadcastRoomUpdate(roomName);
  });

  // --- STREAMING SIGNALS (Host -> Viewer) ---
  // Host sends Offer to a specific Viewer
  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (targetId && sdp) {
        io.to(targetId).emit('webrtc-offer', { sdp, from: socket.id });
    }
  });

  // Viewer sends Answer back to Host
  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    if (targetId && sdp) {
        io.to(targetId).emit('webrtc-answer', { sdp, from: socket.id });
    }
  });

  // ICE Candidates exchange
  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) {
        io.to(targetId).emit('webrtc-ice-candidate', { candidate, from: socket.id });
    }
  });

  // --- CALLING SIGNALS (User <-> User) ---
  // These handle the "Ring" and P2P video calls inside the room
  socket.on('ring-user', (targetId) => {
    if (targetId) {
        io.to(targetId).emit('ring-alert', { from: socket.data.name, fromId: socket.id });
    }
  });

  socket.on('call-offer', ({ targetId, offer }) => {
    if (targetId && offer) {
        io.to(targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer });
    }
  });

  socket.on('call-answer', ({ targetId, answer }) => {
    if (targetId && answer) {
        io.to(targetId).emit('call-answer', { from: socket.id, answer });
    }
  });

  socket.on('call-ice', ({ targetId, candidate }) => {
    if (targetId && candidate) {
        io.to(targetId).emit('call-ice', { from: socket.id, candidate });
    }
  });

  socket.on('call-end', ({ targetId }) => {
    if (targetId) {
        io.to(targetId).emit('call-end', { from: socket.id });
    }
  });

  // --- CHAT & FILES ---
  // 1. Public Chat (Visible to Room + Viewers)
  socket.on('public-chat', ({ room, name, text, fromViewer }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    const info = rooms[roomName];
    
    io.to(roomName).emit('public-chat', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now(),
      isOwner: info && info.ownerId === socket.id,
      fromViewer: !!fromViewer
    });
  });

  // 2. Private Chat (Room Only)
  socket.on('private-chat', ({ room, name, text }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    
    io.to(roomName).emit('private-chat', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now()
    });
  });

  // 3. File Sharing
  socket.on('file-share', ({ room, name, fileName, fileType, fileData }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !fileName || !fileData) return;
    io.to(roomName).emit('file-share', {
      name: name || socket.data.name,
      fileName,
      fileType: fileType || 'application/octet-stream',
      fileData
    });
  });

  // --- DISCONNECT HANDLING ---
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const info = rooms[roomName];
    if (!info) return;

    // Remove user
    info.users.delete(socket.id);

    // If Host left, assign new Host or unlock room
    if (info.ownerId === socket.id) {
      info.ownerId = null;
      info.locked = false;
      
      // Auto-promote next user if exists
      if (info.users.size > 0) {
          const nextId = info.users.keys().next().value;
          info.ownerId = nextId;
          
          const nextSocket = io.sockets.sockets.get(nextId);
          if (nextSocket) {
              nextSocket.emit('role', { isHost: true, streamTitle: info.streamTitle });
          }
      }
    }

    // Notify room
    socket.to(roomName).emit('user-left', { id: socket.id });

    // Cleanup empty room
    if (info.users.size === 0) {
      delete rooms[roomName];
    } else {
      broadcastRoomUpdate(roomName);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel server running on ${PORT}`);
});
