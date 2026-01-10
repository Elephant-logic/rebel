// Rebel Messenger - Render-ready signalling + static server

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static client
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// ---- Socket.io signalling + chat + file meta ----

io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || 'Guest';

    // Notify others
    socket.to(room).emit('system-message', `${socket.data.name} joined the room`);
    console.log(`${socket.data.name} joined room ${room}`);
  });

  socket.on('leave-room', () => {
    const room = socket.data.room;
    if (!room) return;
    socket.leave(room);
    socket.to(room).emit('system-message', `${socket.data.name} left the room`);
    socket.data.room = null;
  });

  // Text chat
  socket.on('chat-message', ({ room, name, text }) => {
    if (!room) return;
    io.to(room).emit('chat-message', {
      name,
      text,
      ts: Date.now()
    });
  });

  // File share (in-memory relay)
  socket.on('file-share', ({ room, name, fileName, fileType, fileSize, fileData }) => {
    if (!room) return;
    // relay to everyone else in room
    socket.to(room).emit('file-share', {
      from: name,
      fileName,
      fileType,
      fileSize,
      fileData // base64 string
    });
  });

  // WebRTC signalling
  socket.on('webrtc-offer', ({ room, sdp }) => {
    socket.to(room).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    socket.to(room).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    socket.to(room).emit('webrtc-ice-candidate', { candidate });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('system-message', `${socket.data.name} disconnected`);
      console.log(`${socket.data.name} disconnected from room ${room}`);
    } else {
      console.log('Client disconnected', socket.id);
    }
  });
});

// ---- Start server ----

const PORT = process.env.PORT || 9100;
server.listen(PORT, () => {
  console.log(`Rebel Messenger signalling server listening on port ${PORT}`);
});
