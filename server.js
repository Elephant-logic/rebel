const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// code -> { code, host, clients: Map(ws -> {wsId,name,seat}), state, version }
const rooms = new Map();

function roomPlayers(room) {
  const arr = [];
  for (const [, info] of room.clients) {
    arr.push({ name: info.name, seat: info.seat, isHost: room.host === info.wsId });
  }
  arr.sort((a, b) => a.seat - b.seat);
  return arr;
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const [ws] of room.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function safeName(n) {
  return (n || "Player").toString().trim().slice(0, 16) || "Player";
}

let wsCounter = 1;

wss.on("connection", (ws) => {
  ws._id = wsCounter++;
  ws._room = null;
  ws._seat = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || !msg.type) return;

    // ======================
    // CREATE ROOM
    // ======================
    if (msg.type === "create_room") {
      if (ws._room) leaveRoom(ws, true);

      let code;
      let requested = (msg.room || "").toString().trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(requested)) requested = "";

      if (requested && !rooms.has(requested)) {
        code = requested;
      } else {
        do { code = makeCode(6); } while (rooms.has(code));
      }

      const room = {
        code,
        host: ws._id,
        clients: new Map(),
        state: null,
        version: 0,
      };
      rooms.set(code, room);

      const name = safeName(msg.name || "Host");
      ws._room = code;
      ws._seat = 0;

      room.clients.set(ws, { wsId: ws._id, name, seat: 0 });

      send(ws, { type: "room_created", ok: true, room: code, seat: 0, hostSeat: 0, players: roomPlayers(room) });

      // tell everyone (host included) the player list + a system chat line
      broadcast(room, { type: "players", hostSeat: 0, players: roomPlayers(room) });
      broadcast(room, { type: "chat", from: "system", message: `${name} created the room.` });

      return;
    }

    // ======================
    // JOIN ROOM
    // ======================
    if (msg.type === "join_room") {
      if (ws._room) leaveRoom(ws, true);

      const code = (msg.room || "").toString().trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "joined", ok: false, message: "Room not found." });

      // assign smallest free seat
      const used = new Set([...room.clients.values()].map(v => v.seat));
      let seat = 0;
      while (used.has(seat)) seat++;

      const name = safeName(msg.name);
      ws._room = code;
      ws._seat = seat;

      room.clients.set(ws, { wsId: ws._id, name, seat });

      const hostSeat = [...room.clients.values()].find(v => v.wsId === room.host)?.seat ?? 0;

      send(ws, { type: "joined", ok: true, room: code, seat, hostSeat, players: roomPlayers(room) });

      // broadcast new roster + join message
      broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });
      broadcast(room, { type: "chat", from: "system", message: `${name} joined the room.` });

      // send latest snapshot if exists
      if (room.state) send(ws, { type: "state", version: room.version, snap: room.state });

      return;
    }

    // ======================
    // LEAVE ROOM
    // ======================
    if (msg.type === "leave_room") {
      leaveRoom(ws, false);
      return;
    }

    // Must be in a room for anything below
    const code = ws._room;
    if (!code) return send(ws, { type: "toast", message: "Not in a room." });

    const room = rooms.get(code);
    if (!room) { ws._room = null; ws._seat = null; return; }

    // ======================
    // HOST STATE SNAPSHOT
    // ======================
    if (msg.type === "state") {
      if (ws._id !== room.host) return; // only host can publish

      room.version = Number.isFinite(Number(msg.version)) ? Number(msg.version) : (room.version + 1);
      room.state = msg.snap;

      broadcast(room, { type: "state", version: room.version, snap: room.state });
      return;
    }

    // ======================
    // ACTION (forward to host)
    // ======================
    if (msg.type === "action") {
      const hostWs = [...room.clients.keys()].find(w => w._id === room.host);
      if (!hostWs) return send(ws, { type: "toast", message: "Host disconnected." });

      const action = msg.action || {};
      action.seat = ws._seat; // enforce seat
      send(hostWs, { type: "to_host_action", action });
      return;
    }

    // ======================
    // CHAT (broadcast to room)
    // ======================
    if (msg.type === "chat") {
      const info = room.clients.get(ws);
      const from = safeName(msg.from || (info ? info.name : "Player"));
      const message = (msg.message || "").toString().slice(0, 240);

      broadcast(room, { type: "chat", from, message });
      return;
    }

    // ignore unknown types safely
  });

  ws.on("close", () => leaveRoom(ws, true));
});

function leaveRoom(ws, silent = false) {
  const code = ws._room;
  if (!code) return;

  const room = rooms.get(code);
  const leavingInfo = room ? room.clients.get(ws) : null;
  const leavingName = leavingInfo ? leavingInfo.name : "A player";

  ws._room = null;
  ws._seat = null;

  if (!room) return;

  room.clients.delete(ws);

  // if host left, pick new host (lowest seat)
  if (room.host === ws._id) {
    const remaining = [...room.clients.values()].sort((a, b) => a.seat - b.seat);
    if (remaining.length) room.host = remaining[0].wsId;
  }

  // delete empty room
  if (room.clients.size === 0) {
    rooms.delete(code);
    return;
  }

  const hostSeat = [...room.clients.values()].find(v => v.wsId === room.host)?.seat ?? 0;

  if (!silent) broadcast(room, { type: "toast", message: `${leavingName} left.` });
  broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });
  broadcast(room, { type: "chat", from: "system", message: `${leavingName} left the room.` });
}

server.listen(PORT, () => console.log("Listening on", PORT));
