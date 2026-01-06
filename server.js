
// Old Skool Blackjack - Server Authoritative Multiplayer (WebSocket)
// Run: npm install && npm start
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req,res)=>res.json({ok:true}));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

function send(ws, obj){
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj){
  room.clients.forEach(ws => send(ws, obj));
}

// --- Simple room registry ---
const rooms = new Map(); // code -> room

function makeCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="";
  for (let i=0;i<5;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function makeDeck(){
  const suits = ["S","H","D","C"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck=[];
  for (const s of suits) for (const r of ranks) deck.push({r,s});
  return deck;
}
function shuffle(a){
  for (let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
}
function cardStr(c){
  const suit = ({S:"♠",H:"♥",D:"♦",C:"♣"})[c.s] || c.s;
  return `${c.r}${suit}`;
}
function suitCharToSuit(suitChar){
  if (suitChar==="♠") return "S";
  if (suitChar==="♥") return "H";
  if (suitChar==="♦") return "D";
  if (suitChar==="♣") return "C";
  return null;
}

// --- Rules (server authority) ---
function isPower(card){
  return ["2","J","A","Q","K"].includes(card.r); // includes King
}
function canPlay(card, top, activeSuit){
  if (!top) return true;
  if (card.r === "A") return true; // ace on anything
  const topSuit = activeSuit || top.s;
  return (card.r === top.r) || (card.s === topSuit);
}

function initialStateFor(players){
  const deck = makeDeck();
  shuffle(deck);
  const state = {
    deck,
    discard: [],
    gamePlayers: players.map(p => ({
      id: p.id,
      name: p.name,
      hand: [],
      declaredLast: false,
      lastCardWarningGiven: false,
    })),
    turnIndex: 0,
    direction: 1,
    activeSuit: null,
    pendingDraw2: 0,
    pendingDrawJ: 0,
    pendingSkip: 0,
    extraTurn: false,
    sortByRank: false,
    acePending: false,
    awaitingSuitBy: null,
  };

  // deal 7 each
  for (let i=0;i<7;i++){
    for (let pi=0;pi<state.gamePlayers.length;pi++){
      state.gamePlayers[pi].hand.push(state.deck.pop());
    }
  }
  // start discard with non-power if possible (try a few draws)
  let start = state.deck.pop();
  let tries=0;
  while (start && isPower(start) && tries<20){
    state.deck.unshift(start);
    shuffle(state.deck);
    start = state.deck.pop();
    tries++;
  }
  state.discard.push(start);
  state.activeSuit = start.s;
  return state;
}

function ensureDeck(state){
  if (state.deck.length > 0) return;
  // reshuffle discard except top
  if (state.discard.length <= 1) return;
  const top = state.discard[state.discard.length-1];
  const rest = state.discard.slice(0,-1);
  state.discard = [top];
  shuffle(rest);
  state.deck = rest;
}

function drawN(state, playerIndex, n){
  for (let i=0;i<n;i++){
    ensureDeck(state);
    const c = state.deck.pop();
    if (!c) break;
    state.gamePlayers[playerIndex].hand.push(c);
  }
}

function nextTurn(state){
  const n = state.gamePlayers.length;
  state.turnIndex = (state.turnIndex + state.direction + n) % n;
  // reset declaredLast each new turn? (your rule: must declare before finishing; we keep flag until turn ends)
}

function applyPenaltiesAndAdvance(state, currentIndex){
  // pending skips handled here
  if (state.pendingSkip > 0){
    state.pendingSkip--;
    nextTurn(state);
  } else {
    nextTurn(state);
  }
}

function attemptPlay(state, playerIndex, indices){
  const player = state.gamePlayers[playerIndex];
  if (state.awaitingSuitBy !== null) return {ok:false, msg:"Suit selection required"};
  if (playerIndex !== state.turnIndex) return {ok:false, msg:"Not your turn"};

  if (!Array.isArray(indices) || indices.length===0) return {ok:false, msg:"No cards selected"};
  // unique + sorted descending to splice safely
  const uniq = [...new Set(indices)].filter(i => Number.isInteger(i)).sort((a,b)=>b-a);
  if (uniq.some(i => i<0 || i>=player.hand.length)) return {ok:false, msg:"Bad selection"};

  const top = state.discard[state.discard.length-1];
  const activeSuit = state.activeSuit;

  // must play same rank if multi
  const first = player.hand[uniq[0]];
  for (const i of uniq){
    if (player.hand[i].r !== first.r) return {ok:false, msg:"Multi-play must be same rank"};
  }

  // validate play against top
  if (!canPlay(first, top, activeSuit)) return {ok:false, msg:"Card doesn't match"};

  // penalty logic if trying to go out without declared last
  const goingOut = (player.hand.length - uniq.length) === 0;
  if (goingOut){
    if (!player.declaredLast){
      // penalty: pick up 2 and cannot finish (cancel play)
      drawN(state, playerIndex, 2);
      player.declaredLast = false;
      return {ok:false, msg:"You must declare LAST before finishing. Penalty: +2"};
    }
    // also cannot finish on a power card (your rule)
    if (isPower(first)){
      drawN(state, playerIndex, 1); // penalty pickup 1 (adjust if your rule differs)
      return {ok:false, msg:"Can't finish on a power card. Penalty: +1"};
    }
  }

  // apply: remove selected cards and put on discard in played order (keep original order by ascending index)
  const asc = [...uniq].sort((a,b)=>a-b);
  const played = asc.map(i => player.hand[i]);
  // remove
  for (const i of uniq) player.hand.splice(i,1);
  // discard
  for (const c of played) state.discard.push(c);

  // reset suit unless ace sets it
  state.activeSuit = played[played.length-1].s;

  // power effects based on last played card rank (classic)
  const last = played[played.length-1];
  if (last.r === "2"){
    state.pendingDraw2 += 2;
  } else if (last.r === "J"){
    state.pendingDrawJ += 1;
  } else if (last.r === "Q"){
    state.direction *= -1;
  } else if (last.r === "K"){
    state.extraTurn = true;
  } else if (last.r === "A"){
    state.awaitingSuitBy = playerIndex;
    // keep acePending for UI
  }

  // clear last declare once turn is used
  player.declaredLast = false;

  // resolve turn advance:
  if (state.awaitingSuitBy !== null){
    // wait for suit selection - don't advance turn yet
    return {ok:true};
  }

  if (state.extraTurn){
    state.extraTurn = false;
    // same player again
    return {ok:true};
  }

  applyPenaltiesAndAdvance(state, playerIndex);
  return {ok:true};
}

function pickup(state, playerIndex){
  if (state.awaitingSuitBy !== null) return {ok:false, msg:"Suit selection required"};
  if (playerIndex !== state.turnIndex) return {ok:false, msg:"Not your turn"};

  const player = state.gamePlayers[playerIndex];

  // apply pending penalties if any
  let total = 0;
  if (state.pendingDraw2>0){ total += state.pendingDraw2; state.pendingDraw2=0; }
  if (state.pendingDrawJ>0){ total += state.pendingDrawJ*5; state.pendingDrawJ=0; }
  if (total===0) total = 1;

  drawN(state, playerIndex, total);

  // end turn
  applyPenaltiesAndAdvance(state, playerIndex);
  player.declaredLast = false;
  return {ok:true, picked: total};
}

function declareLast(state, playerIndex){
  if (playerIndex !== state.turnIndex) return {ok:false, msg:"Not your turn"};
  state.gamePlayers[playerIndex].declaredLast = true;
  return {ok:true};
}

function resolveAce(state, playerIndex, suitChar){
  if (state.awaitingSuitBy === null) return {ok:false, msg:"No ace pending"};
  if (state.awaitingSuitBy !== playerIndex) return {ok:false, msg:"Not your ace"};
  const suit = suitCharToSuit(suitChar);
  if (!suit) return {ok:false, msg:"Bad suit"};
  state.activeSuit = suit;
  state.awaitingSuitBy = null;
  // after ace suit chosen, advance turn (unless extraTurn somehow set)
  applyPenaltiesAndAdvance(state, playerIndex);
  return {ok:true};
}

function roomSnapshot(room){
  const state = room.state || null;
  return {
    roomCode: room.code,
    players: room.players.map(p=>({id:p.id, name:p.name, seat:p.seat})),
    state,
  };
}

// --- WebSocket handling ---
let nextClientId = 1;

wss.on("connection", (ws) => {
  ws._id = String(nextClientId++);

  send(ws, {type:"toast", message:"Connected"});

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }

    if (msg.type === "create"){
      // create room
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const room = { code, players: [], clients: new Set(), state: null, started:false };
      rooms.set(code, room);

      const player = { id: ws._id, name: (msg.name||"Host").slice(0,16), seat: 0, ws };
      room.players.push(player);
      room.clients.add(ws);
      ws._room = code;

      send(ws, {type:"created", roomCode: code, seat: 0, players: room.players.map(p=>({name:p.name, seat:p.seat, id:p.id}))});
      broadcast(room, {type:"room", players: room.players.map(p=>({name:p.name, seat:p.seat, id:p.id}))});
      return;
    }

    if (msg.type === "join"){
      const code = String(msg.roomCode||"").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, {type:"error", message:"Room not found"});
      if (room.players.length >= 4) return send(ws, {type:"error", message:"Room full"});
      // prevent duplicate join
      if (room.players.some(p=>p.id===ws._id)) return;

      const seat = room.players.length;
      const player = { id: ws._id, name: (msg.name||"Guest").slice(0,16), seat, ws };
      room.players.push(player);
      room.clients.add(ws);
      ws._room = code;

      send(ws, {type:"joined", roomCode: code, seat, players: room.players.map(p=>({name:p.name, seat:p.seat, id:p.id}))});
      broadcast(room, {type:"room", players: room.players.map(p=>({name:p.name, seat:p.seat, id:p.id}))});
      if (room.state) send(ws, {type:"state", state: room.state});
      return;
    }

    // actions need room
    const code = String(msg.roomCode||ws._room||"").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(ws, {type:"error", message:"No room"});

    if (msg.type === "deal"){
      // only host (seat 0)
      const host = room.players.find(p=>p.seat===0);
      if (!host || host.id !== ws._id) return send(ws, {type:"error", message:"Only host can deal"});
      if (room.players.length < 2) return send(ws, {type:"error", message:"Need at least 2 players"});
      room.state = initialStateFor(room.players);
      room.started = true;
      broadcast(room, {type:"state", state: room.state});
      return;
    }

    if (msg.type === "action"){
      if (!room.state) return send(ws, {type:"error", message:"Game not started"});
      const player = room.players.find(p=>p.id===ws._id);
      if (!player) return send(ws, {type:"error", message:"Not in room"});
      const st = room.state;
      const a = msg.action || {};
      let res = {ok:false, msg:"Unknown"};
      if (a.kind === "pickup") res = pickup(st, player.seat);
      else if (a.kind === "declare_last") res = declareLast(st, player.seat);
      else if (a.kind === "play") res = attemptPlay(st, player.seat, a.indices || []);
      else if (a.kind === "resolve_ace") res = resolveAce(st, player.seat, a.suitChar);
      else res = {ok:false, msg:"Bad action"};

      if (!res.ok && res.msg) send(ws, {type:"toast", message: res.msg});
      broadcast(room, {type:"state", state: st});
      return;
    }
  });

  ws.on("close", () => {
    const code = ws._room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.clients.delete(ws);
    room.players = room.players.filter(p=>p.id !== ws._id);

    // re-seat players to keep indices 0..n-1
    room.players.forEach((p, i) => p.seat = i);

    if (room.players.length === 0){
      rooms.delete(code);
      return;
    }
    broadcast(room, {type:"room", players: room.players.map(p=>({name:p.name, seat:p.seat, id:p.id}))});
    // NOTE: if game started, seats changed; simplest: restart required (or implement remap)
    if (room.state){
      room.state = null;
      room.started = false;
      broadcast(room, {type:"toast", message:"A player left. Game reset. Host DEAL again."});
    }
  });
});

server.listen(PORT, () => console.log("Server on", PORT));
