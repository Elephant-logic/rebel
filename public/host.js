const socket = io();

// --- ROOM SETUP from URL ---
const url = new URL(window.location.href);
const roomId = url.searchParams.get("room") || "default";
const name = url.searchParams.get("name") || "Host";

document.getElementById("roomLabel").textContent = `Room: ${roomId}`;
socket.emit("join-room", { roomId, name });

let role = null;
socket.on("role", (r) => {
    role = r;
    console.log("Role assigned:", r);
});

// --- LOCK STATUS ---
const lockStatusSpan = document.getElementById("lockStatus");
const btnLock = document.getElementById("btnLock");
let locked = false;

btnLock.onclick = () => { socket.emit("toggle-lock"); };

socket.on("lock-status", ({ locked: isLocked }) => {
    locked = isLocked;
    lockStatusSpan.textContent = locked ? "Locked 🔒" : "Unlocked 🔓";
    btnLock.textContent = locked ? "Unlock Room" : "Lock Room";
});

// --- VIEWER COUNT ---
socket.on("viewer-count", (count) => {
    document.getElementById("viewerCount").textContent = `${count} watching`;
});

// --- CHAT ---
const chatMessages = document.getElementById("chatMessages");
const msgBox = document.getElementById("msgBox");
const btnSend = document.getElementById("btnSend");

btnSend.onclick = sendChat;
msgBox.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

function sendChat() {
    const text = msgBox.value.trim();
    if (!text) return;
    socket.emit("chat", { text });
    msgBox.value = "";
}

socket.on("chat", (msg) => {
    const div = document.createElement("div");
    div.className = "chat-line";
    const idShort = msg.from.slice(0, 5);
    div.innerHTML = `<b>${idShort}:</b> ${msg.text}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// --- WEBRTC HOSTING ---
const iceServers = [
    { urls: "stun:stun.l.google.com:19302" }
];
// If you have TURN credentials, add them to iceServers array

let pcStreamPeers = {}; // viewerId -> RTCPeerConnection
let localStream = null;
const localVideo = document.getElementById("localVideo");

// Start Stream: Capture camera/mic
document.getElementById("btnStream").onclick = async () => {
    if (localStream) return; // already started
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        localVideo.muted = true; // mute local echo
    } catch (e) {
        alert("Camera error: " + e.message);
    }
};

// Screen Share: Replace video track
document.getElementById("btnScreen").onclick = async () => {
    if (!localStream) {
        alert("Start stream first!");
        return;
    }
    try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const newTrack = displayStream.getVideoTracks()[0];
        
        newTrack.onended = () => alert("Screen share ended.");

        // Replace track for all current viewers
        Object.values(pcStreamPeers).forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
            if (sender) sender.replaceTrack(newTrack);
        });

        // Update local preview
        const combined = new MediaStream([newTrack, ...localStream.getAudioTracks()]);
        localVideo.srcObject = combined;
    } catch (e) {
        console.error("Screen share cancelled", e);
    }
};

// Dummy Call Button
document.getElementById("btnCall").onclick = () => {
    alert("In this version, 'Start Stream' handles video. Call logic is identical but 2-way.");
};

// --- SIGNAL HANDLERS ---

socket.on("room-ended", () => {
    alert("Host left. Room ended.");
    location.reload();
});

// 1. Viewer requests stream -> Host creates Offer
socket.on("viewer-wants-stream", async ({ viewerId }) => {
    console.log("Viewer wants stream:", viewerId);
    
    if (!localStream) {
        console.warn("Viewer tried to join, but stream not started yet.");
        return;
    }

    const pc = new RTCPeerConnection({ iceServers });
    pcStreamPeers[viewerId] = pc;

    // Add tracks
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    // ICE Candidates
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("webrtc-ice", { to: viewerId, candidate: e.candidate, kind: "stream" });
        }
    };

    // Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer", { to: viewerId, description: pc.localDescription, kind: "stream" });
});

// 2. Viewer Answers
socket.on("webrtc-answer", async ({ from, description, kind }) => {
    if (kind !== "stream") return;
    const pc = pcStreamPeers[from];
    if (!pc) return;
    await pc.setRemoteDescription(description);
});

// 3. ICE from Viewer
socket.on("webrtc-ice", async ({ from, candidate, kind }) => {
    if (kind !== "stream") return;
    const pc = pcStreamPeers[from];
    if (!pc) return;
    await pc.addIceCandidate(candidate);
});
