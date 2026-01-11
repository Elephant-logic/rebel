import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve static files from 'public' folder
app.use(express.static("public"));

// Route for pretty viewer URLs: /room/test -> serves viewer.html
app.get("/room/:room", (req, res) => {
    res.sendFile("viewer.html", { root: "public" });
});

// roomId -> { host, locked, viewers: {socketId:name} }
const rooms = {};

io.on("connection", (socket) => {
    console.log("connected:", socket.id);

    socket.on("join-room", ({ roomId, name }) => {
        if (!roomId) return;
        if (!rooms[roomId]) {
            rooms[roomId] = { host: null, locked: false, viewers: {} };
        }
        const room = rooms[roomId];

        // If room locked and this isn’t host, reject
        if (room.host && room.locked && socket.id !== room.host) {
            socket.emit("room-locked", { roomId });
            return;
        }

        // First person in is host
        if (!room.host) {
            room.host = socket.id;
            socket.emit("role", "host");
        } else {
            room.viewers[socket.id] = name || "viewer";
            socket.emit("role", "viewer");
        }

        socket.data.roomId = roomId;
        socket.join(roomId);
        updateViewerCount(roomId);
        console.log(`Socket ${socket.id} joined room ${roomId}`);
    });

    socket.on("toggle-lock", () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.host !== socket.id) return; // only host

        room.locked = !room.locked;
        io.to(roomId).emit("lock-status", { locked: room.locked });
        console.log(`Room ${roomId} lock: ${room.locked}`);
    });

    socket.on("chat", ({ text }) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const msg = { from: socket.id, text, ts: Date.now() };
        io.to(roomId).emit("chat", msg);
    });

    // --- WEBRTC SIGNALING ---

    // CRITICAL PATCH: Relay the request from Viewer -> Host
    socket.on("viewer-wants-stream", () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        
        // If host exists, tell them this specific viewer wants the stream
        if (room.host) {
            io.to(room.host).emit("viewer-wants-stream", { viewerId: socket.id });
        }
    });

    socket.on("webrtc-offer", ({ to, description, kind }) => {
        io.to(to).emit("webrtc-offer", { from: socket.id, description, kind });
    });

    socket.on("webrtc-answer", ({ to, description, kind }) => {
        io.to(to).emit("webrtc-answer", { from: socket.id, description, kind });
    });

    socket.on("webrtc-ice", ({ to, candidate, kind }) => {
        io.to(to).emit("webrtc-ice", { from: socket.id, candidate, kind });
    });

    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.host === socket.id) {
            // Host left – destroy room
            delete rooms[roomId];
            io.to(roomId).emit("room-ended");
            console.log(`Room ${roomId} ended (host left)`);
            return;
        }

        if (room.viewers[socket.id]) {
            delete room.viewers[socket.id];
            updateViewerCount(roomId);
            console.log(`Viewer ${socket.id} left room ${roomId}`);
        }
    });
});

function updateViewerCount(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const count = Object.keys(room.viewers).length;
    io.to(roomId).emit("viewer-count", count);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("Rebel server on port", PORT);
});
