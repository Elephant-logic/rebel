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

// Serve /public
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  // Join room
  socket.on('join-room', ({ room, name }) => {
    room = (room || '').trim();
    name = (name || 'Guest').trim();
    if (!room) return;

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    socket.emit('joined-room', { room, you: socket.id, name });
    socket.to(room).emit('user-joined', { id: socket.id, name });
  });

  // Chat – broadcast to the whole room (so everyone sees replies)
  socket.on('chat-message', ({ room, name, text, ts }) => {
    room = (room || '').trim();
    text = (text || '').trim();
    if (!room || !text) return;
    io.to(room).emit('chat-message', { name, text, ts });
  });

  // File share – send to everyone else
  socket.on('file-share', ({ room, name, fileName, dataUrl }) => {
    room = (room || '').trim();
    if (!room || !fileName || !dataUrl) return;
    socket.to(room).emit('file-share', { name, fileName, dataUrl });
  });

  // WebRTC signalling (1:1 call)
  socket.on('webrtc-offer', ({ room, sdp }) => {
    room = (room || '').trim();
    if (!room || !sdp) return;
    socket.to(room).emit('webrtc-offer', { sdp });
  });

  socket.on('webrtc-answer', ({ room, sdp }) => {
    room = (room || '').trim();
    if (!room || !sdp) return;
    socket.to(room).emit('webrtc-answer', { sdp });
  });

  socket.on('webrtc-ice-candidate', ({ room, candidate }) => {
    room = (room || '').trim();
    if (!room || !candidate) return;
    socket.to(room).emit('webrtc-ice-candidate', { candidate });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    const name = socket.data.name;
    if (room) {
      socket.to(room).emit('user-left', { id: socket.id, name });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Rebel Messenger server running on port ${PORT}`);
});
