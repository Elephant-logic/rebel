// REBEL MESSENGER / STREAM SERVER
// ===============================

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Room state:
// rooms[roomId] = {
//   users: [{ id, name, isViewer, requestingCall }],
//   ownerId,
//   locked,
//   streamTitle,
//   // NEW:
//   pendingHostName,
//   hostGraceUntil,
//   hostGraceTimeout
// }
const rooms = {};

function roomState(room) {
    const info = rooms[room];
    if (!info) return null;
    return {
        locked: !!info.locked,
        streamTitle: info.streamTitle || '',
        ownerId: info.ownerId || null,
        users: info.users.map(u => ({
            id: u.id,
            name: u.name,
            isViewer: !!u.isViewer,
            requestingCall: !!u.requestingCall
        }))
    };
}

io.on('connection', socket => {
    socket.currentRoom = null;
    socket.displayName = null;

    // -------------------------------------
    // JOIN ROOM
    // -------------------------------------
    socket.on('join-room', ({ room, name, isViewer }) => {
        if (!room || !name) return;

        // ensure room exists
        if (!rooms[room]) {
            rooms[room] = {
                users: [],
                ownerId: null,
                locked: false,
                streamTitle: '',
                pendingHostName: null,
                hostGraceUntil: null,
                hostGraceTimeout: null
            };
        }

        const info = rooms[room];

        // If room locked and user is NOT host or allowed rejoin, block viewers/guests
        if (info.locked && !info.ownerId) {
            // edge case – locked but no owner, just allow
        }

        socket.currentRoom = room;
        socket.displayName = name;

        // remove any stale entry with same socket id
        info.users = info.users.filter(u => u.id !== socket.id);

        const userObj = {
            id: socket.id,
            name,
            isViewer: !!isViewer,
            requestingCall: false
        };
        info.users.push(userObj);

        // HOST ASSIGNMENT LOGIC
        // ---------------------
        // If there's no current owner…
        if (!info.ownerId && !userObj.isViewer) {
            const now = Date.now();

            // If within grace window and name matches previous host, restore host to this socket
            if (info.pendingHostName &&
                info.hostGraceUntil &&
                now <= info.hostGraceUntil &&
                info.pendingHostName.toLowerCase() === name.toLowerCase()
            ) {
                info.ownerId = socket.id;
                info.pendingHostName = null;
                info.hostGraceUntil = null;
                if (info.hostGraceTimeout) {
                    clearTimeout(info.hostGraceTimeout);
                    info.hostGraceTimeout = null;
                }
            } else {
                // No grace or different user – this user becomes host
                info.ownerId = socket.id;
                info.pendingHostName = null;
                info.hostGraceUntil = null;
                if (info.hostGraceTimeout) {
                    clearTimeout(info.hostGraceTimeout);
                    info.hostGraceTimeout = null;
                }
            }
        }

        socket.join(room);

        // Tell THIS socket if it is host
        socket.emit('role', { isHost: info.ownerId === socket.id });

        // Let others in the room know someone joined
        socket.to(room).emit('user-joined', { id: socket.id, name });

        // Push updated room state
        io.to(room).emit('room-update', roomState(room));
    });

    // -------------------------------------
    // KICK USER (HOST ONLY)
    // -------------------------------------
    socket.on('kick-user', targetId => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];

        if (info.ownerId !== socket.id) return;

        io.to(targetId).emit('kicked');
        io.sockets.sockets.get(targetId)?.leave(room);

        info.users = info.users.filter(u => u.id !== targetId);

        io.to(room).emit('user-left', { id: targetId });
        io.to(room).emit('room-update', roomState(room));
    });

    // -------------------------------------
    // PUBLIC CHAT
    // -------------------------------------
    socket.on('public-chat', ({ room, name, text }) => {
        if (!room || !rooms[room]) return;
        io.to(room).emit('public-chat', {
            name,
            text,
            ts: Date.now()
        });
    });

    // -------------------------------------
    // PRIVATE CHAT
    // -------------------------------------
    socket.on('private-chat', ({ room, name, text }) => {
        if (!room || !rooms[room]) return;
        io.to(room).emit('private-chat', {
            name,
            text,
            ts: Date.now()
        });
    });

    // -------------------------------------
    // FILE SHARE (ROOM-WIDE)
    // -------------------------------------
    socket.on('file-share', ({ room, name, fileName, fileData }) => {
        if (!room || !rooms[room]) return;
        io.to(room).emit('file-share', {
            name,
            fileName,
            fileData
        });
    });

    // -------------------------------------
    // STREAM TITLE
    // -------------------------------------
    socket.on('update-stream-title', title => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];
        if (info.ownerId !== socket.id) return;

        info.streamTitle = title || '';
        io.to(room).emit('room-update', roomState(room));
    });

    // -------------------------------------
    // LOCK / UNLOCK ROOM
    // -------------------------------------
    socket.on('lock-room', locked => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];
        if (info.ownerId !== socket.id) return;

        info.locked = !!locked;
        io.to(room).emit('room-update', roomState(room));
    });

    // -------------------------------------
    // PROMOTE TO HOST (MANUAL HANDOVER)
    // -------------------------------------
    socket.on('promote-to-host', ({ targetId }) => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];
        if (info.ownerId !== socket.id) return;

        const targetUser = info.users.find(u => u.id === targetId);
        if (!targetUser || targetUser.isViewer) return;

        info.ownerId = targetId;
        info.pendingHostName = null;
        info.hostGraceUntil = null;
        if (info.hostGraceTimeout) {
            clearTimeout(info.hostGraceTimeout);
            info.hostGraceTimeout = null;
        }

        // Update roles
        info.users.forEach(u => {
            const s = io.sockets.sockets.get(u.id);
            if (s) s.emit('role', { isHost: u.id === info.ownerId });
        });

        io.to(room).emit('room-update', roomState(room));
    });

    // -------------------------------------
    // RING / CALL (HOST ↔ GUEST)
    // -------------------------------------
    socket.on('ring-user', targetId => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];

        if (info.ownerId !== socket.id) return;

        const me = info.users.find(u => u.id === socket.id);
        const name = me ? me.name : 'Host';

        io.to(targetId).emit('ring-alert', {
            from: name,
            fromId: socket.id
        });
    });

    socket.on('call-offer', ({ targetId, offer }) => {
        io.to(targetId).emit('incoming-call', {
            from: socket.id,
            name: socket.displayName || 'Guest',
            offer
        });
    });

    socket.on('call-answer', ({ targetId, answer }) => {
        io.to(targetId).emit('call-answer', {
            from: socket.id,
            answer
        });
    });

    socket.on('call-ice', ({ targetId, candidate }) => {
        io.to(targetId).emit('call-ice', {
            from: socket.id,
            candidate
        });
    });

    socket.on('call-end', ({ targetId }) => {
        io.to(targetId).emit('call-end', { from: socket.id });
    });

    // -------------------------------------
    // VIEWER WEBRTC (STREAM)
    // -------------------------------------
    socket.on('webrtc-offer', ({ targetId, sdp }) => {
        io.to(targetId).emit('webrtc-offer', {
            from: socket.id,
            sdp
        });
    });

    socket.on('webrtc-answer', ({ targetId, sdp }) => {
        io.to(targetId).emit('webrtc-answer', {
            from: socket.id,
            sdp
        });
    });

    socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
        io.to(targetId).emit('webrtc-ice-candidate', {
            from: socket.id,
            candidate
        });
    });

    // -------------------------------------
    // VIEWER "REQUEST TO CALL" / HAND RAISE
    // -------------------------------------
    socket.on('request-to-call', () => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];

        const me = info.users.find(u => u.id === socket.id);
        if (!me) return;

        me.requestingCall = true;

        if (info.ownerId) {
            io.to(info.ownerId).emit('call-request-received', {
                id: socket.id,
                name: me.name
            });
        }

        io.to(room).emit('room-update', roomState(room));
    });

    socket.on('cancel-call-request', () => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];

        const me = info.users.find(u => u.id === socket.id);
        if (!me) return;

        me.requestingCall = false;
        io.to(room).emit('room-update', roomState(room));
    });

    // -------------------------------------
    // DISCONNECT / LEAVE
    // -------------------------------------
    socket.on('disconnect', () => {
        const room = socket.currentRoom;
        if (!room || !rooms[room]) return;
        const info = rooms[room];

        // find the leaving user *before* removing
        const leavingUser = info.users.find(u => u.id === socket.id);
        info.users = info.users.filter(u => u.id !== socket.id);

        // if room empty, nuke it
        if (!info.users.length) {
            if (info.hostGraceTimeout) clearTimeout(info.hostGraceTimeout);
            delete rooms[room];
            return;
        }

        // HOST GRACE LOGIC
        if (info.ownerId === socket.id && leavingUser && !leavingUser.isViewer) {
            // Keep their name so we can give host back if they return quickly
            info.ownerId = null;
            info.pendingHostName = leavingUser.name;
            info.hostGraceUntil = Date.now() + 60_000; // 60s

            if (info.hostGraceTimeout) clearTimeout(info.hostGraceTimeout);

            // After 60s, if no host yet, auto-promote first non-viewer
            info.hostGraceTimeout = setTimeout(() => {
                const current = rooms[room];
                if (!current) return;

                // if someone already became host, do nothing
                if (current.ownerId) return;

                const newHost = current.users.find(u => !u.isViewer);
                if (newHost) {
                    current.ownerId = newHost.id;
                    current.pendingHostName = null;
                    current.hostGraceUntil = null;
                    current.hostGraceTimeout = null;

                    // push role updates
                    current.users.forEach(u => {
                        const s = io.sockets.sockets.get(u.id);
                        if (s) s.emit('role', { isHost: u.id === current.ownerId });
                    });

                    io.to(room).emit('room-update', roomState(room));
                } else {
                    // Only viewers left, no host – just clear grace flags
                    current.pendingHostName = null;
                    current.hostGraceUntil = null;
                    current.hostGraceTimeout = null;
                    io.to(room).emit('room-update', roomState(room));
                }
            }, 60_000);
        }

        // Inform others that this user left
        io.to(room).emit('user-left', { id: socket.id });
        io.to(room).emit('room-update', roomState(room));
    });
});

server.listen(PORT, () => {
    console.log(`Rebel Stream server running on http://localhost:${PORT}`);
});
