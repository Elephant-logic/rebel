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
    
    // --- JOINING ---
    socket.on('join-room', ({ room, name }) => {
        if (!room) return;

        // Check Lock
        if (rooms[room] && rooms[room].locked) {
            socket.emit('room-error', 'Room is locked by the host.');
            return;
        }

        // Create Room if it doesn't exist
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
        
        const roomObj = rooms[room];
        roomObj.users.push({ id: socket.id, name: socket.data.name });

        // Update everyone with the new user list and lock status
        io.to(room).emit('room-update', {
            users: roomObj.users,
            ownerId: roomObj.ownerId,
            locked: roomObj.locked
        });

        // Notify others
        socket.to(room).emit('user-joined', { id: socket.id, name: socket.data.name });
    });

    // --- TARGETED SIGNALING (MESH ROUTING) ---
    // These events route WebRTC signals to specific users (Target) 
    // or broadcast to the room if no target is specified.

    // Offer
    socket.on('webrtc-offer', (data) => {
        if (data.target) {
            // Direct call to specific user
            io.to(data.target).emit('webrtc-offer', { 
                sdp: data.sdp, 
                from: socket.id,
                name: socket.data.name
            });
        } else {
            // Broadcast (Call All)
            socket.to(data.room).emit('webrtc-offer', { 
                sdp: data.sdp, 
                from: socket.id,
                name: socket.data.name
            });
        }
    });

    // Answer
    socket.on('webrtc-answer', (data) => {
        if (data.target) {
            io.to(data.target).emit('webrtc-answer', { 
                sdp: data.sdp, 
                from: socket.id 
            });
        } else {
            socket.to(data.room).emit('webrtc-answer', { 
                sdp: data.sdp, 
                from: socket.id 
            });
        }
    });

    // ICE Candidates
    socket.on('webrtc-ice-candidate', (data) => {
        if (data.target) {
            io.to(data.target).emit('webrtc-ice-candidate', { 
                candidate: data.candidate, 
                from: socket.id 
            });
        } else {
            socket.to(data.room).emit('webrtc-ice-candidate', { 
                candidate: data.candidate, 
                from: socket.id 
            });
        }
    });

    // --- ADMIN / HOST FEATURES ---

    socket.on('kick-user', (targetId) => {
        const room = socket.data.room;
        if (!room || !rooms[room]) return;
        if (rooms[room].ownerId !== socket.id) return; // Only host can kick

        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.emit('kicked');
            targetSocket.disconnect(true);
        }
    });

    socket.on('lock-room', (lockedState) => {
        const room = socket.data.room;
        if (!room || !rooms[room]) return;
        if (rooms[room].ownerId !== socket.id) return; // Only host can lock
        
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

    socket.on('file-share', (data) => {
        // Files are broadcast to the whole room
        socket.to(data.room).emit('file-share', data);
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        const room = socket.data.room;
        if (room && rooms[room]) {
            // Remove user from list
            rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
            
            // Pass Crown if Host left
            if (rooms[room].ownerId === socket.id) {
                if (rooms[room].users.length > 0) {
                    rooms[room].ownerId = rooms[room].users[0].id; // Next user is Host
                } else {
                    delete rooms[room]; // Room empty
                }
            }

            // Update room if it still exists
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
