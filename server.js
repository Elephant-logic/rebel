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

const rooms = new Map(); // code -> {host, clients: Map(ws -> {name, seat}), state, version}

function roomPlayers(room) {
  const arr = [];
  for (const [, info] of room.clients) {
    arr.push({ name: info.name, seat: info.seat, isHost: room.host === info.wsId });
  }
  arr.sort((a,b)=>a.seat-b.seat);
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

let wsCounter = 1;

wss.on("connection", (ws) => {
  ws._id = wsCounter++;
  ws._room = null;
  ws._seat = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || !msg.type) return;

    if (msg.type === "create_room") {
      // leave previous
      if (ws._room) leaveRoom(ws);

      let code;
      // Host may request a specific room code (4-8 chars A-Z0-9)
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
        nextSeat: 0,
      };
      rooms.set(code, room);

      const name = (msg.name || "Host").toString().slice(0,16);
      ws._room = code;
      ws._seat = 0;

      room.clients.set(ws, { wsId: ws._id, name, seat: 0 });

      send(ws, { type: "room_created", room: code, seat: 0, hostSeat: 0, players: roomPlayers(room) });
      broadcast(room, { type: "players", hostSeat: 0, players: roomPlayers(room) });
      return;
    }

    if (msg.type === "join_room") {
      if (ws._room) leaveRoom(ws);

      const code = (msg.room || "").toString().trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "toast", message: "Room not found." });

      // assign smallest free seat
      const used = new Set([...room.clients.values()].map(v => v.seat));
      let seat = 0;
      while (used.has(seat)) seat++;

      const name = (msg.name || "Player").toString().slice(0,16);
      ws._room = code;
      ws._seat = seat;

      room.clients.set(ws, { wsId: ws._id, name, seat });

      const hostSeat = [...room.clients.values()].find(v => v.wsId === room.host)?.seat ?? 0;

      send(ws, { type: "joined", room: code, seat, hostSeat, players: roomPlayers(room) });
      broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });

      // send latest state if exists
      if (room.state) send(ws, { type: "state", version: room.version, snap: room.state });
      return;
    }

    if (msg.type === "leave_room") {
      leaveRoom(ws);
      return;
    }

    // Must be in a room for the rest
    const code = ws._room;
    if (!code) return send(ws, { type: "toast", message: "Not in a room." });
    const room = rooms.get(code);
    if (!room) { ws._room = null; ws._seat = null; return; }

    if (msg.type === "state") {
      // only host can push authoritative state
      if (ws._id !== room.host) return;

      room.version = Number(msg.version || (room.version + 1));
      room.state = msg.snap;
      broadcast(room, { type: "state", version: room.version, snap: room.state });
      return;
    }

    
    if (msg.type === "ace_prompt") {
      // Host asks a specific seat to pick suit for an Ace. Forward to room.
      if (!ws.room) return;
      const roomId = ws.room;
      const room = rooms.get(roomId);
      if (!room) return;
      broadcastRoom(roomId, { type: "ace_prompt", seat: msg.seat });
      return;
    }

if (msg.type === "action") {
      // forward to host
      const hostWs = [...room.clients.keys()].find(w => w._id === room.host);
      if (!hostWs) return send(ws, { type: "toast", message: "Host disconnected." });

      const action = msg.action || {};
      // Ensure seat is attached
      action.seat = ws._seat;
      send(hostWs, { type: "to_host_action", action });
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(ws, true);
  });
});

function leaveRoom(ws, silent=false) {
  const code = ws._room;
  if (!code) return;
  const room = rooms.get(code);
  ws._room = null;
  ws._seat = null;

  if (!room) return;
  room.clients.delete(ws);

  // if host left, pick a new host (lowest seat)
  if (room.host === ws._id) {
    const remaining = [...room.clients.values()].sort((a,b)=>a.seat-b.seat);
    if (remaining.length) room.host = remaining[0].wsId;
  }

  if (room.clients.size === 0) {
    rooms.delete(code);
    return;
  }

  const hostSeat = [...room.clients.values()].find(v => v.wsId === room.host)?.seat ?? 0;
  if (!silent) broadcast(room, { type: "toast", message: "A player left." });
  broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });
}

server.listen(PORT, () => console.log("Listening on", PORT));
