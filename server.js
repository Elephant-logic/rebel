const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// Simple room state (for host crown + lock later if you want)
const rooms = new Map();
// rooms[roomName] = { hostId, locked: false, users: Map<socketId,{id,name}> }

function getOrCreateRoom(roomName, hostId, hostName) {
  let r = rooms.get(roomName);
  if (!r) {
    r = {
      hostId,
      locked: false,
      users: new Map()
    };
    rooms.set(roomName, r);
  }
  if (!r.users.has(hostId)) {
    r.users.set(hostId, { id: hostId, name: hostName || 'Host' });
  }
  return r;
}

function broadcastRoomState(roomName) {
  const r = rooms.get(roomName);
  if (!r) return;
  io.to(roomName).emit('room-state', {
    hostId: r.hostId,
    locked: r.locked,
    users: Array.from(r.users.values())
  });
}

io.on('connection', (socket) => {
  socket.data.roomName = null;
  socket.data.userName = null;

  // Main room join (chat + call)
  socket.on('join-room', ({ room, name }) => {
    const roomName = (room || '').trim();
    const userName = (name || 'Guest').trim();
    if (!roomName) return;

    const existing = rooms.get(roomName);
    if (existing && existing.locked && existing.hostId !== socket.id) {
      socket.emit('room-locked', { room: roomName });
      return;
    }

    socket.join(roomName);
    socket.data.roomName = roomName;
    socket.data.userName = userName;

    const r = getOrCreateRoom(roomName, existing?.hostId || socket.id, userName);

    if (!r.hostId) {
      r.hostId = socket.id;
    }

    r.users.set(socket.id, { id: socket.id, name: userName });

    socket.emit('joined-room', { room: roomName, you: socket.id, name: userName });
    socket.to(roomName).emit('user-joined', { id: socket.id, name: userName });

    broadcastRoomState(roomName);
  });

  // Optional lock (for later UI)
  socket.on('toggle-lock', () => {
    const roomName = socket.data.roomName;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r) return;
    if (r.hostId !== socket.id) return;
    r.locked = !r.locked;
    broadcastRoomState(roomName);
  });

  // Viewer joins stream room
  socket.on('join-stream-room', ({ room, name }) => {
    const streamRoom = `${room}-stream`;
    socket.join(streamRoom);
    socket.data.streamRoom = streamRoom;
    socket.data.viewerName = (name || 'Viewer').trim();
    socket.emit('joined-stream-room', { room: streamRoom, you: socket.id });
  });

  // HOST joins stream room (when Start Stream pressed)
  socket.on('host-join-stream', ({ room }) => {
    const streamRoom = `${room}-stream`;
    socket.join(streamRoom);
    socket.data.streamRoom = streamRoom;
  });

  // Chat (main room) – broadcast to everyone in room (host + joiners)
  socket.on('chat-message', ({ room, name, text, ts }) => {
    const roomName = (room || '').trim();
    if (!roomName || !text) return;
    io.to(roomName).emit('chat-message', { name, text, ts });
  });

  // Stream chat (viewer page)
  socket.on('stream-chat-message', ({ room, name, text, ts }) => {
    const streamRoom = `${room}-stream`;
    if (!room || !text) return;
    io.to(streamRoom).emit('stream-chat-message', { name, text, ts });
  });

  // File share in main room
  socket.on('file-share', ({ room, name, fileName, dataUrl }) => {
    const roomName = (room || '').trim();
    if (!roomName || !fileName || !dataUrl) return;
    socket.to(roomName).emit('file-share', { name, fileName, dataUrl });
  });

  // CALL WebRTC signalling (1:1 call in main room)
  socket.on('webrtc-offer', ({ room, sdp }) => {
    const roomName = (room || '').trim();
    if (!roomName || !sdp) return;
    socket.to(roomName).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    const roomName = (room || '').trim();
    if (!roomName || !sdp) return;
    socket.to(roomName).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    const roomName = (room || '').trim();
    if (!roomName || !candidate) return;
    socket.to(roomName).emit('webrtc-ice-candidate', { candidate });
  });

  // STREAM WebRTC signalling (host -> viewers)
  socket.on('stream-offer', ({ room, sdp }) => {
    if (!room || !sdp) return;
    const streamRoom = `${room}-stream`;
    socket.to(streamRoom).emit('stream-offer', { sdp });
  });

  socket.on('stream-answer', ({ room, sdp }) => {
    if (!room || !sdp) return;
    const streamRoom = `${room}-stream`;
    socket.to(streamRoom).emit('stream-answer', { sdp });
  });

  socket.on('stream-ice-candidate', ({ room, candidate }) => {
    if (!room || !candidate) return;
    const streamRoom = `${room}-stream`;
    socket.to(streamRoom).emit('stream-ice-candidate', { candidate });
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.roomName;
    if (!roomName) return;

    const r = rooms.get(roomName);
    if (!r) return;

    r.users.delete(socket.id);

    if (r.hostId === socket.id) {
      const first = r.users.keys().next();
      if (!first.done) {
        r.hostId = first.value;
      } else {
        rooms.delete(roomName);
        return;
      }
    }

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
