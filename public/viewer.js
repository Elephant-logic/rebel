const socket = io();
const url = new URL(window.location.href);

// Handle both /room/test and ?room=test
const roomId = url.pathname.startsWith("/room/") 
    ? url.pathname.split("/").pop() 
    : url.searchParams.get("room") || "default";

const name = url.searchParams.get("name") || "Viewer";

document.getElementById("vRoomLabel").textContent = `Room: ${roomId}`;
socket.emit("join-room", { roomId, name });

socket.on("room-locked", () => {
    alert("This room is locked by the host.");
    document.body.innerHTML = "<h1>Room Locked</h1>";
});

socket.on("viewer-count", (count) => {
    document.getElementById("vViewerCount").textContent = `${count} watching`;
});

// --- CHAT ---
const vMsgs = document.getElementById("vMsgs");
const vMsg = document.getElementById("vMsg");
const vSend = document.getElementById("vSend");

vSend.onclick = sendChat;
vMsg.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

function sendChat() {
    const text = vMsg.value.trim();
    if (!text) return;
    socket.emit("chat", { text });
    vMsg.value = "";
}

socket.on("chat", (msg) => {
    const div = document.createElement("div");
    div.className = "chat-line";
    const idShort = msg.from.slice(0, 5);
    div.innerHTML = `<b>${idShort}:</b> ${msg.text}`;
    vMsgs.appendChild(div);
    vMsgs.scrollTop = vMsgs.scrollHeight;
});

// --- WEBRTC RECEIVER ---
let pc;
const streamVideo = document.getElementById("streamVideo");
const waitingMsg = document.getElementById("waitingMsg");
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

// Triggered when we successfully join as 'viewer'
socket.on("role", (r) => {
    if (r === "viewer") {
        console.log("Asking host for stream...");
        socket.emit("viewer-wants-stream");
    }
});

// Host sent an offer
socket.on("webrtc-offer", async ({ from, description, kind }) => {
    if (kind !== "stream") return;
    
    waitingMsg.style.display = "none";
    pc = new RTCPeerConnection({ iceServers });

    pc.ontrack = (e) => {
        streamVideo.srcObject = e.streams[0];
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("webrtc-ice", { to: from, candidate: e.candidate, kind: "stream" });
        }
    };

    await pc.setRemoteDescription(description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("webrtc-answer", { to: from, description: pc.localDescription, kind: "stream" });
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
