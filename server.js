const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);

// ------------- SOCKET.IO SETUP (50MB buffer, tuned pings) -------------
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 5e7,       // 50MB – for Arcade / tools
  pingTimeout: 10000,
  pingInterval: 25000,
});

// ------------- STATIC FILES -------------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ------------- IN-MEMORY ROOM STATE -------------

/**
 * rooms[roomName] = {
 *   users: Map<socketId, { id, name, isViewer, isHost, requestingCall }>
 *   ownerId: string | null       // current host / owner
 *   locked: boolean
 *   streamTitle: string
 *   streamLive: boolean          // we treat as "always on" for now
 */
const rooms = Object.create(null);

function getRoom(roomName) {
  if (!roomName) return null;
  if (!rooms[roomName]) {
    rooms[roomName] = {
      users: new Map(),
      ownerId: null,
      locked: false,
      streamTitle: "Untitled Stream",
      streamLive: true,
    };
  }
  return rooms[roomName];
}

function serialiseUsers(info) {
  return Array.from(info.users.values()).map((u) => ({
    id: u.id,
    name: u.name,
    isViewer: !!u.isViewer,
    isHost: !!u.isHost,
    requestingCall: !!u.requestingCall,
  }));
}

function broadcastRoomUpdate(roomName) {
  const info = rooms[roomName];
  if (!info) return;
  io.to(roomName).emit("room-update", {
    locked: info.locked,
    streamTitle: info.streamTitle,
    ownerId: info.ownerId,
    streamLive: info.streamLive,
    users: serialiseUsers(info),
  });
}

// ------------- SOCKET LOGIC -------------

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // store per-socket metadata
  socket.data.room = null;
  socket.data.name = null;
  socket.data.isViewer = false;

  // ---------- JOIN ROOM ----------
  socket.on("join-room", ({ room, name, isViewer }) => {
    try {
      room = (room || "").trim();
      name = (name || "User").trim();

      if (!room) {
        socket.emit("room-error", "Room required.");
        return;
      }

      const info = getRoom(room);

      // hard lock – if locked and no owner slot for you, deny
      if (info.locked && info.ownerId && info.ownerId !== socket.id) {
        socket.emit("room-error", "Room is locked.");
        return;
      }

      socket.join(room);
      socket.data.room = room;
      socket.data.name = name;
      socket.data.isViewer = !!isViewer;

      // decide host / owner
      if (!info.ownerId && !isViewer) {
        info.ownerId = socket.id;
      }

      const isHost = info.ownerId === socket.id && !isViewer;

      info.users.set(socket.id, {
        id: socket.id,
        name,
        isViewer: !!isViewer,
        isHost,
        requestingCall: false,
      });

      // tell this client its role
      socket.emit("role", { isHost });

      // notify others
      socket.to(room).emit("user-joined", { id: socket.id, name });

      broadcastRoomUpdate(room);
    } catch (err) {
      console.error("join-room error", err);
      socket.emit("room-error", "Failed to join room.");
    }
  });

  // ---------- PUBLIC CHAT ----------
  socket.on("public-chat", ({ room, name, text }) => {
    room = room || socket.data.room;
    if (!room) return;

    const ts = Date.now();
    io.to(room).emit("public-chat", {
      room,
      name: name || socket.data.name || "User",
      text: text || "",
      ts,
    });
  });

  // ---------- PRIVATE CHAT (host / backstage) ----------
  socket.on("private-chat", ({ room, name, text }) => {
    room = room || socket.data.room;
    if (!room) return;
    const info = rooms[room];
    if (!info) return;

    const ts = Date.now();
    io.to(room).emit("private-chat", {
      room,
      name: name || socket.data.name || "User",
      text: text || "",
      ts,
    });
  });

  // ---------- FILE SHARE ----------
  socket.on("file-share", ({ room, name, fileName, fileData }) => {
    room = room || socket.data.room;
    if (!room) return;
    io.to(room).emit("file-share", {
      room,
      name: name || socket.data.name || "User",
      fileName,
      fileData,
    });
  });

  // ---------- OVERLAY UPDATE (NEW) ----------
  socket.on("overlay-update", ({ room, html }) => {
    room = room || socket.data.room;
    if (!room || typeof html !== "string") return;

    io.to(room).emit("overlay-update", {
      html: String(html),
    });
  });

  // ---------- LOCK ROOM ----------
  socket.on("lock-room", (locked) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    info.locked = !!locked;
    broadcastRoomUpdate(roomName);
  });

  // ---------- UPDATE STREAM TITLE ----------
  socket.on("update-stream-title", (title) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    info.streamTitle = (title || "Untitled Stream").slice(0, 100);
    broadcastRoomUpdate(roomName);
  });

  // ---------- PROMOTE TO HOST ----------
  socket.on("promote-to-host", ({ targetId }) => {
    const roomName = socket.data.room;
    if (!roomName || !targetId) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    if (!info.users.has(targetId)) return;

    // clear old
    if (info.users.has(info.ownerId)) {
      const old = info.users.get(info.ownerId);
      old.isHost = false;
      info.users.set(info.ownerId, old);
      io.to(info.ownerId).emit("role", { isHost: false });
    }

    info.ownerId = targetId;

    const nu = info.users.get(targetId);
    nu.isHost = true;
    info.users.set(targetId, nu);

    io.to(targetId).emit("role", { isHost: true });
    broadcastRoomUpdate(roomName);
  });

  // ---------- KICK USER ----------
  socket.on("kick-user", (targetId) => {
    const roomName = socket.data.room;
    if (!roomName || !targetId) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    if (!info.users.has(targetId)) return;

    io.to(targetId).emit("kicked");
    io.sockets.sockets.get(targetId)?.leave(roomName);
    info.users.delete(targetId);

    io.to(roomName).emit("user-left", { id: targetId });
    if (info.users.size === 0) delete rooms[roomName];
    else broadcastRoomUpdate(roomName);
  });

  // ---------- CALL REQUEST (viewer raises hand) ----------
  socket.on("call-request", ({ room }) => {
    room = room || socket.data.room;
    if (!room) return;
    const info = rooms[room];
    if (!info) return;

    const user = info.users.get(socket.id);
    if (!user) return;

    user.requestingCall = true;
    info.users.set(socket.id, user);

    if (info.ownerId) {
      io.to(info.ownerId).emit("call-request-received", {
        id: socket.id,
        name: user.name,
      });
    }

    broadcastRoomUpdate(room);
  });

  // ---------- RING USER (host → viewer) ----------
  socket.on("ring-user", (targetId) => {
    const roomName = socket.data.room;
    if (!roomName || !targetId) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

    const user = info.users.get(targetId);
    if (!user) return;

    // clear "requesting" flag
    user.requestingCall = false;
    info.users.set(targetId, user);
    broadcastRoomUpdate(roomName);

    io.to(targetId).emit("ring-alert", {
      from: socket.data.name || "Host",
      fromId: socket.id,
    });
  });

  // ---------- 1-to-1 CALL OFFER ----------
  socket.on("call-offer", ({ targetId, offer }) => {
    const roomName = socket.data.room;
    if (!roomName || !offer) return;
    const info = rooms[roomName];
    if (!info) return;

    let destId = targetId;

    // viewer calling host: no targetId supplied
    if (!destId) destId = info.ownerId;
    if (!destId || destId === socket.id) return;

    io.to(destId).emit("incoming-call", {
      from: socket.id,
      name: socket.data.name || "User",
      offer,
    });
  });

  // ---------- 1-to-1 CALL ANSWER ----------
  socket.on("call-answer", ({ targetId, answer }) => {
    if (!targetId || !answer) return;
    io.to(targetId).emit("call-answer", {
      from: socket.id,
      answer,
    });
  });

  // ---------- 1-to-1 CALL ICE ----------
  socket.on("call-ice", ({ targetId, candidate }) => {
    const roomName = socket.data.room;
    if (!roomName || !candidate) return;
    const info = rooms[roomName];
    if (!info) return;

    let destId = targetId;

    // viewer sending ice → host
    if (!destId) destId = info.ownerId;
    if (!destId || destId === socket.id) return;

    io.to(destId).emit("call-ice", {
      from: socket.id,
      candidate,
    });
  });

  // ---------- END CALL ----------
  socket.on("call-end", ({ targetId } = {}) => {
    const roomName = socket.data.room;
    const info = rooms[roomName];

    if (targetId) {
      io.to(targetId).emit("call-end", { from: socket.id });
    } else if (info && info.ownerId) {
      // viewer without explicit target → host
      io.to(info.ownerId).emit("call-end", { from: socket.id });
    }
  });

  // ---------- BROADCAST WEBRTC (CANVAS STREAM) ----------
  socket.on("webrtc-offer", ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit("webrtc-offer", { from: socket.id, sdp });
  });

  socket.on("webrtc-answer", ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit("webrtc-answer", { from: socket.id, sdp });
  });

  socket.on("webrtc-ice-candidate", ({ targetId, candidate }) => {
    if (!targetId || !candidate) return;
    io.to(targetId).emit("webrtc-ice-candidate", { from: socket.id, candidate });
  });

  // ---------- DISCONNECT ----------
  socket.on("disconnect", () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info) return;

    info.users.delete(socket.id);

    if (info.ownerId === socket.id) {
      info.ownerId = null;
    }

    socket.to(roomName).emit("user-left", { id: socket.id });

    if (info.users.size === 0) {
      delete rooms[roomName];
    } else {
      broadcastRoomUpdate(roomName);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Rebel Secure Server running on ${PORT}`);
});
