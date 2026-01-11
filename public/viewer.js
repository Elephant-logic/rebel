const socket = io();

// figure out room from /view.html?room=xxx or /room/xxx
const url = new URL(window.location.href);
let roomId;

if (url.pathname.startsWith("/room/")) {
  roomId = url.pathname.split("/").pop();
} else {
  roomId = url.searchParams.get("room") || "default";
}

const name = url.searchParams.get("name") || "Viewer";

const vRoomLabel = document.getElementById("vRoomLabel");
const vViewerCount = document.getElementById("vViewerCount");
const vMsgs = document.getElementById("vMsgs");
const vMsg = document.getElementById("vMsg");
const vSend = document.getElementById("vSend");
const waitingMsg = document.getElementById("waitingMsg");
const streamVideo = document.getElementById("streamVideo");

vRoomLabel.textContent = `Room: ${roomId}`;

// join as viewer
socket.emit("join-room", { roomId, name });

socket.on("room-locked", () => {
  alert("This room is locked by the host.");
  document.body.innerHTML = "<h1>Room Locked</h1>";
});

socket.on("viewer-count", (count) => {
  vViewerCount.textContent = `${count} watching`;
});

// ask host for stream once we know we're viewer
socket.on("role", (r) => {
  if (r === "viewer") {
    console.log("Asking host for stream");
    socket.emit("viewer-wants-stream");
  }
});

// --- CHAT ---

function appendChat(html) {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.innerHTML = html;
  vMsgs.appendChild(div);
  vMsgs.scrollTop = vMsgs.scrollHeight;
}

vSend.onclick = () => sendChat();
vMsg.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

function sendChat() {
  const text = vMsg.value.trim();
  if (!text) return;
  socket.emit("chat", { text });
  vMsg.value = "";
}

socket.on("chat", msg => {
  const who = msg.from === socket.id ? "You" : msg.from.slice(0, 5);
  const t = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  appendChat(
    `<span class="meta">${who}</span><span class="meta">${t}</span>${msg.text}`
  );
});

// --- WEBRTC RECEIVER ---

let pc;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

socket.on("webrtc-offer", async ({ from, description, kind }) => {
  if (kind !== "stream") return;

  waitingMsg.style.display = "none";

  pc = new RTCPeerConnection({ iceServers });

  pc.ontrack = (e) => {
    streamVideo.srcObject = e.streams[0];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("webrtc-ice", {
        to: from,
        candidate: e.candidate,
        kind: "stream"
      });
    }
  };

  await pc.setRemoteDescription(description);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit("webrtc-answer", {
    to: from,
    description: pc.localDescription,
    kind: "stream"
  });
});

socket.on("webrtc-ice", async ({ from, candidate, kind }) => {
  if (kind !== "stream") return;
  if (!pc) return;
  await pc.addIceCandidate(candidate);
});

socket.on("room-ended", () => {
  alert("Broadcast ended.");
  location.reload();
});
