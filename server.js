// REBEL SERVER — public root layout (Render-safe)
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- STATIC FILES: serve /public ----
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// root -> public/index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// room tracking
const rooms = {};

// ------------- SOCKET LOGIC -------------
io.on('connection', (socket) => {

  // ROOM JOIN
  socket.on('join-room', ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name || `User-${String(Math.random()).slice(2, 6)}`;

    if (!rooms[room]) rooms[room] = { users: [] };
    rooms[room].users.push({ id: socket.id, name: socket.data.name });

    io.to(room).emit('room-users', rooms[room].users);
    socket.to(room).emit('user-joined', socket.id);
  });

  // CALL SIGNALS
  socket.on('webrtc-offer', data => socket.to(data.room).emit('webrtc-offer', data));
  socket.on('webrtc-answer', data => socket.to(data.room).emit('webrtc-answer', data));
  socket.on('webrtc-ice-candidate', data => socket.to(data.room).emit('webrtc-ice-candidate', data));

  // CHAT
  socket.on('chat-message', data => socket.to(data.room).emit('chat-message', data));

  // FILES
  socket.on('file-share', data => socket.to(data.room).emit('file-share', data));

  // DISCONNECT
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms[room]) {
      rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
      io.to(room).emit('room-users', rooms[room].users);
      if (!rooms[room].users.length) delete rooms[room];
    }
  });
});

// START SERVER (Render uses PORT env)
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`REBEL server running on port ${PORT}`);
});
