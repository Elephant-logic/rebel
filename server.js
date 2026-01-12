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
// rooms[roomName] = { ownerId: 'socketId', locked: false, users: [] }
const rooms = {};

io.on('connection', (socket) => {
    
    socket.on('join-room', ({ room, name }) => {
        if (!room) return;

        // Check lock status
        if (rooms[room] && rooms[room].locked) {
            socket.emit('room-error', 'Room is locked by the host.');
            return;
        }

        // Create room if new
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
        
        // Add to list
        const roomObj = rooms[room];
        roomObj.users.push({ id: socket.id, name: socket.data.name });

        // Update everyone
        io.to(room).emit('room-update', {
            users: roomObj.users,
            ownerId: roomObj.ownerId,
            locked: roomObj.locked
        });

        // Trigger stream auto-connect logic
        socket.to(room).emit('user-joined', { id: socket.id, name: socket.data.name });
    });

    // --- ADMIN COMMANDS ---
    socket.on('kick-user', (targetId) => {
        const room = socket.data.room;
        if (!room || !rooms[room]) return;
        if (rooms[room].ownerId !== socket.id) return; // Only owner

        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.emit('kicked');
            targetSocket.disconnect(true);
        }
    });

    socket.on('lock-room', (lockedState) => {
        const room = socket.data.room;
        if (!room || !rooms[room]) return;
        if (rooms[room].ownerId !== socket.id) return;

        rooms[room].locked = lockedState;
        io.to(room).emit('room-update', {
            users: rooms[room].users,
            ownerId: rooms[room].ownerId,
            locked: rooms[room].locked
        });
    });

    socket.on('ring-user', (targetId) => {
        io.to(targetId).emit('ring-alert', { from: socket.data.name });
    });

    // --- WEBRTC RELAY ---
    socket.on('webrtc-offer', (data) => socket.to(data.room).emit('webrtc-offer', { sdp: data.sdp }));
    socket.on('webrtc-answer', (data) => socket.to(data.room).emit('webrtc-answer', { sdp: data.sdp }));
    socket.on('webrtc-ice-candidate', (data) => socket.to(data.room).emit('webrtc-ice-candidate', { candidate: data.candidate }));

    // --- CHAT & FILES ---
    socket.on('chat-message', (data) => {
        const room = socket.data.room;
        if(room && rooms[room]) {
            const isOwner = (rooms[room].ownerId === socket.id);
            socket.to(room).emit('chat-message', {
                name: data.name,
                text: data.text,
                ts: Date.now(),
                isOwner: isOwner
            });
        }
    });

    socket.on('file-share', (data) => socket.to(data.room).emit('file-share', data));

    socket.on('disconnect', () => {
        const room = socket.data.room;
        if (room && rooms[room]) {
            // Remove user
            rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
            
            // Assign new host if host left
            if (rooms[room].ownerId === socket.id) {
                if (rooms[room].users.length > 0) {
                    rooms[room].ownerId = rooms[room].users[0].id;
                } else {
                    delete rooms[room];
                }
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
