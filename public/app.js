// REBEL HOST – SINGLE STREAM VERSION
const socket = io({ autoConnect: false });

// ---------- State ----------
let currentRoom = null;
let userName = "Host";

let localStream = null;
let screenStream = null;
let isScreenSharing = false;

let pc = null;                 // one broadcast peer connection

// ---------- ICE ----------
const iceConfig = (typeof ICE_SERVERS !== "undefined" && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const joinBtn         = $("joinBtn");
const roomInput       = $("roomInput");
const roomInfo        = $("roomInfo");
const signalStatusEl  = $("signalStatus");

const startCallBtn    = $("startCallBtn");
const hangupBtn       = $("hangupBtn");
const shareScreenBtn  = $("shareScreenBtn");
const toggleCamBtn    = $("toggleCamBtn");
const toggleMicBtn    = $("toggleMicBtn");

const localVideo      = $("localVideo");
const streamLinkInput = $("streamLinkInput");
const openStreamBtn   = $("openStreamBtn");

// chat + files
const chatLog       = $("chatLog");
const chatInput     = $("chatInput");
const sendBtn       = $("sendBtn");
const emojiStrip    = $("emojiStrip");
const fileInput     = $("fileInput");
const sendFileBtn   = $("sendFileBtn");
const fileNameLabel = $("fileNameLabel");

// ---------- Helpers ----------
function setSignal(connected) {
  if (!signalStatusEl) return;
  signalStatusEl.textContent = connected ? "Connected" : "Disconnected";
  signalStatusEl.classList.toggle("status-connected", connected);
  signalStatusEl.classList.toggle("status-disconnected", !connected);
}

function logChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const line = document.createElement("div");
  line.className = "chat-line";
  const when = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const who  = name === "You"
    ? `<span style="color:#4af3a3">${name}</span>`
    : `<strong>${name}</strong>`;
  line.innerHTML = `${who} <small>${when}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.muted = true;
    }
    return localStream;
  } catch (err) {
    alert("Camera / mic error: " + err.message);
    throw err;
  }
}

// ---------- WebRTC ----------
async function startBroadcast() {
  if (!currentRoom) {
    alert("Join a room first");
    return;
  }
  await ensureLocalStream();

  if (pc) {
    pc.close();
    pc = null;
  }

  pc = new RTCPeerConnection(iceConfig);

  // host -> viewer ICE
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("webrtc-ice-candidate", {
        room: currentRoom,
        candidate: e.candidate,
      });
    }
  };

  // add tracks from whichever stream is active
  const stream = isScreenSharing && screenStream ? screenStream : localStream;
  if (stream) {
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit("webrtc-offer", {
    room: currentRoom,
    sdp: pc.localDescription,
  });

  startCallBtn.disabled = true;
  startCallBtn.textContent = "Streaming Active";
  if (hangupBtn) hangupBtn.disabled = false;
}

function stopBroadcast() {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (localVideo) localVideo.srcObject = null;

  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = "Share Screen";

  if (startCallBtn) {
    startCallBtn.disabled = false;
    startCallBtn.textContent = "Start Call";
  }
  if (hangupBtn) hangupBtn.disabled = true;
}

// when a viewer joins or rejoins, simply re-offer
socket.on("user-joined", () => {
  if (localStream || screenStream) {
    startBroadcast().catch(console.error);
  }
});

// viewer's answer
socket.on("webrtc-answer", async ({ sdp }) => {
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

// viewer ICE
socket.on("webrtc-ice-candidate", async ({ candidate }) => {
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error(e);
    }
  }
});

// ---------- Socket basic ----------
socket.on("connect", () => setSignal(true));
socket.on("disconnect", () => setSignal(false));

// ---------- Join / Leave ----------
if (joinBtn) {
  joinBtn.addEventListener("click", () => {
    const room = roomInput.value.trim();
    if (!room) return alert("Enter room name");

    currentRoom = room;
    userName = "Host"; // could hook an input later

    socket.connect();
    socket.emit("join-room", { room, name: userName });

    joinBtn.disabled = true;
    if (roomInfo) roomInfo.textContent = `Room: ${room}`;

    // build viewer URL
    const url = new URL(window.location.href);
    url.pathname = "/view.html";
    url.searchParams.set("room", room);
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

if (hangupBtn) {
  hangupBtn.addEventListener("click", stopBroadcast);
}

if (startCallBtn) {
  startCallBtn.addEventListener("click", () => {
    startBroadcast().catch(console.error);
  });
}

if (shareScreenBtn) {
  shareScreenBtn.addEventListener("click", async () => {
    if (!localStream && !screenStream) {
      await ensureLocalStream();
    }

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const screenTrack = screenStream.getVideoTracks()[0];

        if (pc) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        }

        if (localVideo) localVideo.srcObject = screenStream;
        isScreenSharing = true;
        shareScreenBtn.textContent = "Stop Screen";

        screenTrack.onended = () => {
          stopScreenShare();
        };
      } catch (e) {
        console.error(e);
      }
    } else {
      stopScreenShare();
    }
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;

  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  if (localStream && pc) {
    const camTrack = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender && camTrack) sender.replaceTrack(camTrack);
  }

  if (localVideo && localStream) localVideo.srcObject = localStream;
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = "Share Screen";
}

// cam / mic toggles
if (toggleCamBtn) {
  toggleCamBtn.addEventListener("click", () => {
    if (!localStream) return;
    const enabled = localStream.getVideoTracks().some((t) => t.enabled);
    localStream.getVideoTracks().forEach((t) => (t.enabled = !enabled));
    toggleCamBtn.textContent = enabled ? "Camera On" : "Camera Off";
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener("click", () => {
    if (!localStream) return;
    const enabled = localStream.getAudioTracks().some((t) => t.enabled);
    localStream.getAudioTracks().forEach((t) => (t.enabled = !enabled));
    toggleMicBtn.textContent = enabled ? "Unmute" : "Mute";
  });
}

// open viewer
if (openStreamBtn) {
  openStreamBtn.addEventListener("click", () => {
    const url = streamLinkInput && streamLinkInput.value;
    if (url) window.open(url, "_blank");
  });
}

// ---------- Chat ----------
socket.on("chat-message", ({ name, text, ts }) => {
  logChat(name, text, ts);
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit("chat-message", { room: currentRoom, name: userName, text });
  logChat("You", text);
  chatInput.value = "";
}

if (sendBtn) {
  sendBtn.addEventListener("click", sendChat);
}
if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
}
if (emojiStrip) {
  emojiStrip.addEventListener("click", (e) => {
    if (e.target.classList.contains("emoji")) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

// ---------- File share ----------
if (fileInput && sendFileBtn) {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (fileNameLabel) fileNameLabel.textContent = file ? file.name : "No file";
    sendFileBtn.disabled = !file;
  });

  sendFileBtn.addEventListener("click", () => {
    const file = fileInput.files[0];
    if (!file || !currentRoom) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      socket.emit("file-share", {
        room: currentRoom,
        name: userName,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        fileData: base64,
      });
      logChat("You", `Sent file: ${file.name}`);
      fileInput.value = "";
      if (fileNameLabel) fileNameLabel.textContent = "No file";
      sendFileBtn.disabled = true;
    };
    reader.readAsDataURL(file);
  });
}

socket.on("file-share", ({ from, fileName, fileType, fileSize, fileData }) => {
  const href = `data:${fileType};base64,${fileData}`;
  const link = `<a href="${href}" download="${fileName}" style="color:#4af3a3">Download ${fileName}</a>`;
  logChat(from, `Sent a file: ${link}`);
});
