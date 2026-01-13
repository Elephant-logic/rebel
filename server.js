const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static client from /public
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------
// UPLOADS (local, 15-minute TTL)
// -----------------------------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// id -> { path, createdAt, originalName, mime }
const storedFiles = new Map();
const FILE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Download route: /files/:id
app.get('/files/:id', (req, res) => {
  const id = req.params.id;
  const meta = storedFiles.get(id);
  if (!meta) {
    return res.status(404).send('File not found or expired');
  }

  // Check expiry on access
  if (Date.now() - meta.createdAt > FILE_TTL_MS) {
    try { fs.unlinkSync(meta.path); } catch (e) {}
    storedFiles.delete(id);
    return res.status(410).send('File has expired');
  }

  res.sendFile(meta.path);
});

// Periodic cleanup just in case
setInterval(() => {
  const now = Date.now();
  for (const [id, meta] of storedFiles.entries()) {
    if (now - meta.createdAt > FILE_TTL_MS) {
      try { fs.unlinkSync(meta.path); } catch (e) {}
      storedFiles.delete(id);
    }
  }
}, 5 * 60 * 1000); // every 5 minutes

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

    // If locked & not owner, reject
    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked by host');
      socket.disconnect();
      return;
    }

    const displayName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;

    // First user becomes Host
    if (!info.ownerId) {
      info.ownerId = socket.id;
    }

    info.users.set(socket.id, { name: displayName });

    // Tell this socket its role
    socket.emit('role', {
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle
    });

    // Tell others somebody joined
    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });

    broadcastRoomUpdate(roomName);
  });

  // --- HOST CONTROLS ---
  socket.on('lock-room', (locked) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
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
  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (targetId && sdp) {
      io.to(targetId).emit('webrtc-offer', { sdp, from: socket.id });
    }
  });

  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    if (targetId && sdp) {
      io.to(targetId).emit('webrtc-answer', { sdp, from: socket.id });
    }
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) {
      io.to(targetId).emit('webrtc-ice-candidate', { candidate, from: socket.id });
    }
  });

  // --- CALLING SIGNALS (User <-> User) ---
  socket.on('ring-user', (targetId) => {
    if (targetId) {
      io.to(targetId).emit('ring-alert', {
        from: socket.data.name,
        fromId: socket.id
      });
    }
  });

  socket.on('call-offer', ({ targetId, offer }) => {
    if (targetId && offer) {
      io.to(targetId).emit('incoming-call', {
        from: socket.id,
        name: socket.data.name,
        offer
      });
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

  // 1. Public chat (room + viewers)
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

  // 2. Room chat
  socket.on('private-chat', ({ room, name, text }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;

    io.to(roomName).emit('private-chat', {
      name: name || socket.data.name || 'Anon',
      text,
      ts: Date.now()
    });
  });

  // 3. FILE SHARE: save to disk -> send link
  socket.on('file-share', ({ room, name, fileName, fileType, fileData, targetId }) => {
    const roomName = room || socket.data.room;
    if (!fileName || !fileData) return;

    // Expect data: URL → split header + base64
    const parts = String(fileData).split(',');
    if (parts.length < 2) return;
    const base64Data = parts[1];

    const buffer = Buffer.from(base64Data, 'base64');
    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = path.join(uploadsDir, `${id}-${safeName}`);

    fs.writeFile(filePath, buffer, (err) => {
      if (err) {
        console.error('File write error:', err);
        return;
      }

      storedFiles.set(id, {
        path: filePath,
        createdAt: Date.now(),
        originalName: fileName,
        mime: fileType || 'application/octet-stream'
      });

      const fileUrl = `/files/${id}`;

      const payload = {
        name: name || socket.data.name,
        fileName,
        fileType: fileType || 'application/octet-stream',
        fileUrl
      };

      if (targetId) {
        io.to(targetId).emit('file-share', payload);
      } else if (roomName) {
        io.to(roomName).emit('file-share', payload);
      }
    });
  });

  // --- DISCONNECT HANDLING ---
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;

    const info = rooms[roomName];
    if (!info) return;

    info.users.delete(socket.id);

    if (info.ownerId === socket.id) {
      info.ownerId = null;
      info.locked = false;

      // Promote next user if exists
      if (info.users.size > 0) {
        const nextId = info.users.keys().next().value;
        info.ownerId = nextId;

        const nextSocket = io.sockets.sockets.get(nextId);
        if (nextSocket) {
          nextSocket.emit('role', {
            isHost: true,
            streamTitle: info.streamTitle
          });
        }
      }
    }

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
