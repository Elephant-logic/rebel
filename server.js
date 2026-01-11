const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve everything from /public
app.use(express.static(path.join(__dirname, 'public')));

// Optional: make sure "/" always serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  // Join a room (host or viewer)
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    // Tell other people in the room that someone joined
    socket.to(room).emit('user-joined', {
      id: socket.id,
      name: socket.data.name,
    });
  });

  // --- WebRTC signalling (same events for host + viewers) ---

  // Host → viewers: offer
  socket.on('webrtc-offer', (data) => {
    // data: { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-offer', {
      sdp: data.sdp,
    });
  });

  // Viewer → host: answer
  socket.on('webrtc-answer', (data) => {
    // data: { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-answer', {
      sdp: data.sdp,
    });
  });

  // Both ways: ICE
  socket.on('webrtc-ice-candidate', (data) => {
    // data: { room, candidate }
    if (!data || !data.room || !data.candidate) return;
    socket.to(data.room).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
    });
  });

  // --- Chat (no echo to sender – they add their own line) ---
  socket.on('chat-message', (data) => {
    // data: { room, name, text }
    if (!data || !data.room || !data.text) return;
    const payload = {
      name: data.name || 'Anon',
      text: data.text,
      ts: Date.now(),
    };
    socket.to(data.room).emit('chat-message', payload);
  });

  // --- File share passthrough ---
  socket.on('file-share', (data) => {
    // just relay to everyone else in the room
    if (!data || !data.room) return;
    socket.to(data.room).emit('file-share', data);
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('user-left', { id: socket.id });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
