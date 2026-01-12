const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ROOM STATE
const rooms = {};

io.on('connection', (socket) => {
    
    socket.on('join-room', ({ room, name }) => {
        if (!room) return;

        if (rooms[room] && rooms[room].locked) {
            socket.emit('room-error', 'Room is locked by the host.');
            return;
        }

        if (!rooms[room]) {
            rooms[room] = { 
                ownerId: socket.id, 
                locked: false, 
                users: [] 
            };
        }

        socket.join(room);
        socket.data.room = room;
        socket.data.name = name || 'Anon';
        
        // Update user list
        const roomObj = rooms[room];
        roomObj.users = roomObj.users.filter(u => u.id !== socket.id);
        roomObj.users.push({ id: socket.id, name: socket.data.name });

        // Broadcast State
        io.to(room).emit('room-update', {
            users: roomObj.users,
            ownerId: roomObj.ownerId,
            locked: roomObj.locked
        });

        // Notify others specifically
        socket.to(room).emit('user-joined', { id: socket.id, name: socket.data.name });
    });

    // --- SIGNALING (Direct & Broadcast) ---

    socket.on('webrtc-offer', (data) => {
        if (data.target) {
            io.to(data.target).emit('webrtc-offer', { 
                sdp: data.sdp, from: socket.id, name: socket.data.name 
            });
        } else {
            socket.to(data.room).emit('webrtc-offer', { 
                sdp: data.sdp, from: socket.id, name: socket.data.name 
            });
        }
    });

    socket.on('webrtc-answer', (data) => {
        if (data.target) {
            io.to(data.target).emit('webrtc-answer', { sdp: data.sdp, from: socket.id });
        } else {
            socket.to(data.room).emit('webrtc-answer', { sdp: data.sdp, from: socket.id });
        }
    });

    socket.on('webrtc-ice-candidate', (data) => {
        if (data.target) {
            io.to(data.target).emit('webrtc-ice-candidate', { candidate: data.candidate, from: socket.id });
        } else {
            socket.to(data.room).emit('webrtc-ice-candidate', { candidate: data.candidate, from: socket.id });
        }
    });

    // --- ADMIN ---
    socket.on('kick-user', (targetId) => {
        const room = socket.data.room;
        if (!room || !rooms[room]) return;
        if (rooms[room].ownerId !== socket.id) return;
        const target = io.sockets.sockets.get(targetId);
        if (target) {
            target.emit('kicked');
            target.disconnect(true);
        }
    });

    socket.on('lock-room', (locked) => {
        const room = socket.data.room;
        if (!room || !rooms[room] || rooms[room].ownerId !== socket.id) return;
        rooms[room].locked = locked;
        io.to(room).emit('room-update', {
            users: rooms[room].users,
            ownerId: rooms[room].ownerId,
            locked: rooms[room].locked
        });
    });

    socket.on('ring-user', (targetId) => {
        io.to(targetId).emit('ring-alert', { from: socket.data.name });
    });

    // --- CHAT & FILES ---
    socket.on('chat-message', (data) => {
        const room = socket.data.room;
        if(room && rooms[room]) {
            socket.to(room).emit('chat-message', {
                name: data.name, text: data.text, ts: Date.now(), isOwner: (rooms[room].ownerId === socket.id)
            });
        }
    });

    socket.on('file-share', (data) => socket.to(data.room).emit('file-share', data));

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        const room = socket.data.room;
        if (room && rooms[room]) {
            rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
            if (rooms[room].ownerId === socket.id) {
                rooms[room].ownerId = rooms[room].users.length ? rooms[room].users[0].id : null;
                if(!rooms[room].ownerId) delete rooms[room];
            }
            if (rooms[room]) {
                io.to(room).emit('room-update', {
                    users: rooms[room].users,
                    ownerId: rooms[room].ownerId,
                    locked: rooms[room].locked
                });
                io.to(room).emit('user-left', { id: socket.id });
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Rebel server running on ${PORT}`);
});
