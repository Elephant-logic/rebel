// VIEWER – STREAM + CHAT
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random() * 1000)}`;

// Use ICE_SERVERS from config/ice.js if available
const iceConfig = {
  iceServers: (typeof ICE_SERVERS !== "undefined" && ICE_SERVERS.length)
    ? ICE_SERVERS
    : [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
};

// Elements from view.html
const viewerVideo  = document.getElementById("viewerVideo");
const statusEl     = document.getElementById("statusText");
const chatLog      = document.getElementById("chatLog");
const chatInput    = document.getElementById("chatInput");
const sendBtn      = document.getElementById("sendBtn");
const emojiStrip   = document.getElementById("emojiStrip");
const hideChatBtn  = document.getElementById("hideChatBtn");
const muteBtn      = document.getElementById("muteBtn");

// ---- ROOM SETUP ----
(function initRoom() {
  const url = new URL(window.location.href);
  const room = url.searchParams.get("room") || "default";
  const name = url.searchParams.get("name") || myName;
  currentRoom = room;
  myName = name;

  const roomTitle = document.getElementById("roomTitle");
  if (roomTitle) roomTitle.textContent = `Room: ${currentRoom}`;

  setStatus(`Connecting to room: ${currentRoom}...`);

  socket.connect();
  socket.emit("join-room", { room: currentRoom, name: myName });

  // VERY IMPORTANT: tell host we need a fresh stream offer
  socket.emit("stream-hello", { room: currentRoom });
})();

// ---- WEBRTC HANDLING ----
async function ensurePc() {
  if (pc) return pc;
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (viewerVideo) {
      viewerVideo.srcObject = stream;
      viewerVideo.play().catch(() => {});
    }
    setStatus("Live");
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-ice-candidate", {
        room: currentRoom,
        candidate: event.candidate
      });
    }
  };

  return pc;
}

socket.on("webrtc-offer", async ({ room, sdp }) => {
  if (room !== currentRoom) return;

  try {
    const pcLocal = await ensurePc();
    await pcLocal.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pcLocal.createAnswer();
    await pcLocal.setLocalDescription(answer);
    socket.emit("webrtc-answer", {
      room: currentRoom,
      sdp: pcLocal.localDescription
    });
  } catch (err) {
    console.error("Error handling offer:", err);
    setStatus("Error connecting");
  }
});

socket.on("webrtc-ice-candidate", async ({ room, candidate }) => {
  if (room !== currentRoom || !pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error("ICE error:", err);
  }
});

// If host leaves / room empties you could listen for user-left here if you want

// ---- CHAT ----
if (sendBtn) sendBtn.addEventListener("click", sendChat);
if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
}
if (emojiStrip && chatInput) {
  emojiStrip.addEventListener("click", (e) => {
    if (!e.target.classList.contains("emoji")) return;
    chatInput.value += e.target.textContent;
    chatInput.focus();
  });
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  const ts = Date.now();
  socket.emit("chat-message", { room: currentRoom, name: myName, text, ts });
  appendChat("You", text, ts);
  chatInput.value = "";
}

socket.on("chat-message", ({ name, text, ts }) => {
  appendChat(name || "Host", text, ts);
});

function appendChat(name, text, ts) {
  if (!chatLog) return;
  const line = document.createElement("div");
  line.className = "chat-line";

  const time = new Date(ts || Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  const who = name === "You"
    ? `<span class="meta">You</span>`
    : `<span class="meta">${name}</span>`;

  line.innerHTML = `${who} <span class="meta">${time}</span> ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---- SIMPLE UI CONTROLS (Hide chat / mute) ----
if (hideChatBtn && chatLog) {
  const chatWrapper = document.getElementById("chatWrapper");
  hideChatBtn.addEventListener("click", () => {
    const hidden = chatWrapper.classList.toggle("hidden");
    hideChatBtn.textContent = hidden ? "Show Chat" : "Hide Chat";
  });
}

if (muteBtn && viewerVideo) {
  viewerVideo.muted = true;
  muteBtn.textContent = "Unmute";
  muteBtn.addEventListener("click", () => {
    viewerVideo.muted = !viewerVideo.muted;
    muteBtn.textContent = viewerVideo.muted ? "Unmute" : "Mute";
  });
}

// ---- STATUS HELPER ----
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}
