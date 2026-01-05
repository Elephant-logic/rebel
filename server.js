const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: { origin: "*" } // This lets your phone connect securely
});

// This holds the list of players in memory
let players = {}; 

io.on("connection", (socket) => {
  console.log("A player connected!", socket.id);

  // When a phone says "I'm here!"
  socket.on("joinGame", (name) => {
    players[socket.id] = { name: name, score: 0 };
    // Tell everyone the new list
    io.emit("updateLobby", Object.values(players));
  });

  // When a phone says "I played a card"
  socket.on("playMove", (data) => {
    // Shout it to everyone else
    socket.broadcast.emit("opponentAction", data);
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("updateLobby", Object.values(players));
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
