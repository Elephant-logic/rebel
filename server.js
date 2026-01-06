// Old Skool Blackjack - WebSocket Room Server (Render-ready)
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function makeCode(len=4){
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}
function makeId(){
  return crypto.randomBytes(8).toString("hex");
}

const rooms = new Map(); // code -> {code, players:[{id,name,ws,index}], state, v, createdAt}

function roomPublicPlayers(room){
  return room.players.map(p => ({ id: p.id, name: p.name, index: p.index }));
}
function wsSend(ws, obj){
  try{ ws.send(JSON.stringify(obj)); }catch{}
}
function broadcast(room, obj){
  const msg = JSON.stringify(obj);
  room.players.forEach(p => { try{ p.ws.send(msg); }catch{} });
}
function cleanupRoomIfEmpty(code){
  const room = rooms.get(code);
  if (!room) return;
  room.players = room.players.filter(p => p.ws.readyState === WebSocket.OPEN);
  if (room.players.length === 0) rooms.delete(code);
}

wss.on("connection", (ws) => {
  ws._id = makeId();
  ws._room = null;

  ws.on("message", (data) => {
    let msg;
    try{ msg = JSON.parse(data.toString("utf-8")); }catch{ return; }
    const t = msg.t;

    if (t === "create"){
      // Create a new room
      let code;
      do { code = makeCode(4); } while (rooms.has(code));

      const room = {
        code,
        players: [],
        state: null,
        v: 0,
        createdAt: Date.now(),
      };

      const name = String(msg.name || "Player").slice(0, 24);
      const player = { id: ws._id, name, ws, index: 0, isHost: true };
      room.players.push(player);
      rooms.set(code, room);
      ws._room = code;

      wsSend(ws, { t:"room", code, you:{id:player.id, index:0, isHost:true}, players: roomPublicPlayers(room), state: room.state, v: room.v });
      broadcast(room, { t:"players", code, players: roomPublicPlayers(room) });
      return;
    }

    if (t === "join"){
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room){
        wsSend(ws, { t:"error", message:"Room not found" });
        return;
      }
      if (room.players.length >= 4){
        wsSend(ws, { t:"error", message:"Room full" });
        return;
      }

      const name = String(msg.name || "Player").slice(0, 24);
      // assign lowest free index 0..3
      const used = new Set(room.players.map(p=>p.index));
      let idx = 0; while (used.has(idx) && idx < 4) idx++;

      const player = { id: ws._id, name, ws, index: idx, isHost: false };
      room.players.push(player);
      ws._room = code;

      wsSend(ws, { t:"room", code, you:{id:player.id, index:idx, isHost:false}, players: roomPublicPlayers(room), state: room.state, v: room.v });
      broadcast(room, { t:"players", code, players: roomPublicPlayers(room) });
      return;
    }

    if (t === "state"){
      const code = ws._room || String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room){
        wsSend(ws, { t:"error", message:"Not in a room" });
        return;
      }
      // Only accept state updates from connected room members
      const sender = room.players.find(p => p.id === ws._id);
      if (!sender){
        wsSend(ws, { t:"error", message:"Not a room member" });
        return;
      }

      // First state must come from host, after that accept from anyone (simple & robust).
      // If you want to harden later: only accept from current-turn player.
      if (!room.state && !sender.isHost){
        wsSend(ws, { t:"error", message:"Waiting for host to start the game" });
        return;
      }

      room.state = msg.state;
      room.v = (room.v || 0) + 1;
      broadcast(room, { t:"state", code, state: room.state, v: room.v });
      return;
    }

    if (t === "leave"){
      const code = ws._room || String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return;

      room.players = room.players.filter(p => p.id !== ws._id);
      ws._room = null;

      // If host left, promote next player to host
      if (!room.players.some(p=>p.isHost) && room.players.length){
        room.players[0].isHost = true;
      }

      broadcast(room, { t:"players", code, players: roomPublicPlayers(room) });
      cleanupRoomIfEmpty(code);
      return;
    }
  });

  ws.on("close", () => {
    const code = ws._room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== ws._id);

    // promote host if needed
    if (!room.players.some(p=>p.isHost) && room.players.length){
      room.players[0].isHost = true;
    }

    broadcast(room, { t:"players", code, players: roomPublicPlayers(room) });
    cleanupRoomIfEmpty(code);
  });
});

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
