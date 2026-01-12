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

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Anon';

    // tell everyone else in the room a user joined
    socket.to(room).emit('user-joined', {
      id: socket.id,
      name: socket.data.name
    });
  });

  // Host → viewers: offer
  socket.on('webrtc-offer', (data) => {
    // { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-offer', { sdp: data.sdp });
  });

  // Viewer → host: answer
  socket.on('webrtc-answer', (data) => {
    // { room, sdp }
    if (!data || !data.room || !data.sdp) return;
    socket.to(data.room).emit('webrtc-answer', { sdp: data.sdp });
  });

  // ICE both ways
  socket.on('webrtc-ice-candidate', (data) => {
    // { room, candidate }
    if (!data || !data.room || !data.candidate) return;
    socket.to(data.room).emit('webrtc-ice-candidate', {
      candidate: data.candidate
    });
  });

  // Chat relay
  socket.on('chat-message', (data) => {
    // { room, name, text }
    if (!data || !data.room || !data.text) return;
    socket.to(data.room).emit('chat-message', {
      name: data.name || 'Anon',
      text: data.text,
      ts: Date.now()
    });
  });

  // File relay
  socket.on('file-share', (data) => {
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
  console.log(`Rebel server running on ${PORT}`);
});
