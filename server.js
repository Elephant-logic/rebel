// ==================================================
//  REBEL SERVER — MULTI CALL + BROADCAST STREAM
// ==================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {}; // room => { users: [ {id,name} ] }

io.on('connection', socket => {

  // ===== JOIN ROOM =====
  socket.on('join-room', ({ room, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    if (!rooms[room]) rooms[room] = { users: [] };
    rooms[room].users.push({ id: socket.id, name });

    io.to(room).emit('room-users', rooms[room].users);

    // tell stream viewers host exists
    io.to(`stream-${room}`).emit('viewer-joined');
  });

  // ===== CALL SDP =====
  socket.on('webrtc-offer-call', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc-offer-call', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-answer-call', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc-answer-call', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-ice-call', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-call', { fromId: socket.id, candidate });
  });

  // ===== STREAM JOIN =====
  socket.on('join-stream', ({ streamRoom }) => {
    socket.join(streamRoom);
    socket.data.streamRoom = streamRoom;

    // tell host someone is watching
    const base = streamRoom.replace('stream-', '');
    io.to(base).emit('viewer-joined');
  });

  // ===== STREAM SDP =====
  socket.on('webrtc-offer-stream', ({ sdp, streamRoom }) => {
    // forward offer to viewers (view.html)
    socket.to(streamRoom).emit('webrtc-offer-stream', { sdp });
  });

  socket.on('webrtc-answer-stream', ({ sdp, streamRoom }) => {
    // forward answer BACK to host
    const base = streamRoom.replace('stream-', '');
    io.to(base).emit('webrtc-answer-stream', { sdp });
  });

  socket.on('webrtc-ice-stream', ({ candidate, streamRoom }) => {
    const base = streamRoom.replace('stream-', '');
    // viewer → host and host → viewer (bi-directional)
    socket.to(streamRoom).emit('webrtc-ice-stream', { candidate });
    socket.to(base).emit('webrtc-ice-stream', { candidate });
  });

  // ===== CHAT + FILES =====
  socket.on('chat-message', ({ room, name, text }) => {
    io.to(room).emit('chat-message', { name, text });
  });

  socket.on('file-share', ({ room, name, filename, content }) => {
    io.to(room).emit('file-share', { name, filename, content });
  });

  // ===== DISCONNECT =====
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms[room]) {
      rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
      io.to(room).emit('room-users', rooms[room].users);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`REBEL server running on ${PORT}`));
