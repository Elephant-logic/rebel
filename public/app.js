// HOST – CALL + STREAM
const socket = io();

// URL params allow ?room=Beef&name=Host
const url = new URL(window.location.href);
const defaultRoom = url.searchParams.get("room") || "";
const defaultName = url.searchParams.get("name") || "";

// ---- DOM ----
const $ = id => document.getElementById(id);

const nameInput = $("nameInput");
const roomInput = $("roomInput");
const joinBtn = $("joinBtn");
const leaveBtn = $("leaveBtn");
const roomLabel = $("roomLabel");
const lockStatus = $("lockStatus");
const viewerCountLabel = $("viewerCount");

const localVideo = $("localVideo");
const remoteVideo = $("remoteVideo");

const btnCall = $("btnCall");
const btnStream = $("btnStream");
const btnScreen = $("btnScreen");
const btnSwapCam = $("btnSwapCam");
const btnLock = $("btnLock");
const btnCamToggle = $("btnCamToggle");
const btnMute = $("btnMute");

const streamLinkInput = $("streamLink");
const btnOpenStream = $("btnOpenStream");

const chatMessages = $("chatMessages");
const msgBox = $("msgBox");
const btnSend = $("btnSend");
const emojiStrip = $("emojiStrip");

const tabChat = $("tabChat");
const tabShared = $("tabShared");
const sharedPanel = $("sharedPanel");
const sharedPreview = $("sharedPreview");

// preset fields
roomInput.value = defaultRoom;
nameInput.value = defaultName;

// ---- STATE ----
let role = null;                // "host" / "viewer" (host page is always host)
let roomId = null;              // main room for chat/call
let streamRoomId = null;        // random room for stream viewers

let callPc = null;              // main 2-way call
let streamPeers = {};           // viewerId -> RTCPeerConnection for stream
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

let videoDevices = [];
let currentVideoDeviceId = null;

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" }
];

// ---- UTIL ----

function logChatLine(html) {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.innerHTML = html;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function makeTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- JOIN / LEAVE ----

joinBtn.onclick = () => {
  const r = roomInput.value.trim();
  const n = nameInput.value.trim() || "Host";
  if (!r) return alert("Enter room name");

  roomId = r;
  socket.emit("join-room", { roomId, name: n });

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  roomLabel.textContent = `Room: ${roomId}`;
};

leaveBtn.onclick = () => {
  // easiest: reload page
  location.href = "/";
};

socket.on("role", r => {
  role = r;
  console.log("role:", r);
});

socket.on("viewer-count", count => {
  viewerCountLabel.textContent = `${count} watching`;
});

socket.on("lock-status", ({ locked }) => {
  lockStatus.textContent = locked ? "Locked 🔒" : "Unlocked 🔓";
  btnLock.textContent = locked ? "Unlock Room" : "Lock Room";
});

btnLock.onclick = () => {
  socket.emit("toggle-lock");
};

// ---- CHAT ----

btnSend.onclick = sendChat;
msgBox.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

if (emojiStrip) {
  emojiStrip.addEventListener("click", e => {
    if (!e.target.classList.contains("emoji")) return;
    msgBox.value += e.target.textContent;
    msgBox.focus();
  });
}

function sendChat() {
  const text = msgBox.value.trim();
  if (!text || !roomId) return;
  socket.emit("chat", { text });
  msgBox.value = "";
}

socket.on("chat", msg => {
  const who = msg.from === socket.id ? "You" : msg.from.slice(0, 5);
  const t = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  logChatLine(
    `<span class="meta">${who}</span><span class="meta">${t}</span>${msg.text}`
  );
});

// ---- TABS ----

tabChat.onclick = () => {
  tabChat.classList.add("activeTab");
  tabShared.classList.remove("activeTab");
  chatMessages.style.display = "block";
  sharedPanel.classList.add("hidden");
};

tabShared.onclick = () => {
  tabShared.classList.add("activeTab");
  tabChat.classList.remove("activeTab");
  chatMessages.style.display = "none";
  sharedPanel.classList.remove("hidden");
};

// ---- MEDIA ----

async function ensureLocalStream() {
  if (localStream) return;

  let constraints = { video: true, audio: true };
  if (currentVideoDeviceId) {
    constraints = {
      video: { deviceId: { exact: currentVideoDeviceId } },
      audio: true
    };
  }

  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  localVideo.srcObject = localStream;
  localVideo.muted = true;

  // also show in shared preview by default
  sharedPreview.srcObject = localStream;

  await refreshVideoDevices();
}

async function refreshVideoDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  videoDevices = devs.filter(d => d.kind === "videoinput");
  if (!currentVideoDeviceId && videoDevices[0]) {
    currentVideoDeviceId = videoDevices[0].deviceId;
  }
}

// ---- CALL (2-WAY) ----

btnCall.onclick = async () => {
  if (!roomId) return alert("Join room first");
  try {
    await ensureLocalStream();
  } catch (e) {
    return alert("Camera error: " + e.message);
  }

  if (callPc) {
    // hang up
    callPc.close();
    callPc = null;
    remoteVideo.srcObject = null;
    btnCall.textContent = "Start Call";
    return;
  }

  callPc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach(t => callPc.addTrack(t, localStream));
  callPc.ontrack = e => {
    remoteVideo.srcObject = e.streams[0];
  };
  callPc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit("webrtc-ice", {
        to: null,              // for call we relay via room – simple version
        candidate: e.candidate,
        kind: "call"
      });
    }
  };

  const offer = await callPc.createOffer();
  await callPc.setLocalDescription(offer);
  socket.emit("webrtc-offer", {
    to: null,
    description: callPc.localDescription,
    kind: "call"
  });

  btnCall.textContent = "End Call";
};

// ---- STREAM (ONE-WAY TO VIEWERS) ----

btnStream.onclick = async () => {
  if (!roomId) return alert("Join room first");
  try {
    await ensureLocalStream();
  } catch (e) {
    return alert("Camera error: " + e.message);
  }

  // start or stop stream
  const active = btnStream.dataset.active === "1";
  if (active) {
    Object.values(streamPeers).forEach(pc => pc.close());
    streamPeers = {};
    btnStream.dataset.active = "0";
    btnStream.textContent = "Start Stream";
    return;
  }

  // choose random stream room
  const rand = Math.floor(100000 + Math.random() * 900000);
  streamRoomId = `stream-${rand}`;
  socket.emit("join-room", { roomId: streamRoomId, name: "HostStream" });

  // build share link
  const u = new URL(window.location.href);
  u.pathname = "/view.html";
  u.searchParams.set("room", streamRoomId);
  streamLinkInput.value = u.toString();

  btnStream.dataset.active = "1";
  btnStream.textContent = "Stop Stream";
};

// viewer has joined and asked for stream
socket.on("viewer-wants-stream", async ({ viewerId }) => {
  console.log("viewer-wants-stream", viewerId);

  if (!localStream) return;

  const pc = new RTCPeerConnection({ iceServers });
  streamPeers[viewerId] = pc;

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit("webrtc-ice", {
        to: viewerId,
        candidate: e.candidate,
        kind: "stream"
      });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit("webrtc-offer", {
    to: viewerId,
    description: pc.localDescription,
    kind: "stream"
  });
});

// answer from viewer
socket.on("webrtc-answer", async ({ from, description, kind }) => {
  if (kind === "stream") {
    const pc = streamPeers[from];
    if (!pc) return;
    await pc.setRemoteDescription(description);
  } else if (kind === "call" && callPc) {
    await callPc.setRemoteDescription(description);
  }
});

socket.on("webrtc-ice", async ({ from, candidate, kind }) => {
  if (kind === "stream") {
    const pc = streamPeers[from];
    if (!pc) return;
    await pc.addIceCandidate(candidate);
  } else if (kind === "call" && callPc) {
    await callPc.addIceCandidate(candidate);
  }
});

socket.on("room-ended", () => {
  alert("Broadcast ended.");
  location.reload();
});

// ---- SCREEN SHARE (affects both call + stream) ----

btnScreen.onclick = async () => {
  if (!localStream) return alert("Start call or stream first");

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      const replaceVideoTrack = (pc) => {
        if (!pc) return;
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      };

      replaceVideoTrack(callPc);
      Object.values(streamPeers).forEach(replaceVideoTrack);

      const combined = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
      localVideo.srcObject = combined;
      sharedPreview.srcObject = combined;

      screenTrack.onended = stopScreenShare;
      isScreenSharing = true;
      btnScreen.textContent = "Stop Screen";
    } catch (e) {
      console.error("screen share error", e);
    }
  } else {
    stopScreenShare();
  }
};

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  const camTrack = localStream.getVideoTracks()[0];
  const replaceVideoTrack = (pc) => {
    if (!pc) return;
    const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
    if (sender) sender.replaceTrack(camTrack);
  };

  replaceVideoTrack(callPc);
  Object.values(streamPeers).forEach(replaceVideoTrack);

  localVideo.srcObject = localStream;
  sharedPreview.srcObject = localStream;

  isScreenSharing = false;
  btnScreen.textContent = "Share Screen";
}

// ---- CAMERA / MIC TOGGLES ----

btnCamToggle.onclick = () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  btnCamToggle.textContent = track.enabled ? "Camera Off" : "Camera On";
};

btnMute.onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  btnMute.textContent = track.enabled ? "Mute" : "Unmute";
};

// ---- SWAP CAM ----

btnSwapCam.onclick = async () => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return alert("No multi-camera support");
  }
  await refreshVideoDevices();
  if (videoDevices.length <= 1) {
    return alert("No second camera found");
  }

  const idx = videoDevices.findIndex(d => d.deviceId === currentVideoDeviceId);
  const next = (idx + 1) % videoDevices.length;
  currentVideoDeviceId = videoDevices[next].deviceId;

  // re-get media with new device
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: currentVideoDeviceId } },
    audio: true
  });

  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = newStream;
  localVideo.srcObject = localStream;
  sharedPreview.srcObject = localStream;

  // update tracks in existing connections
  const updatePc = (pc) => {
    if (!pc) return;
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
      const sender = senders.find(s => s.track && s.track.kind === track.kind);
      if (sender) sender.replaceTrack(track);
    });
  };
  updatePc(callPc);
  Object.values(streamPeers).forEach(updatePc);
};

// ---- STREAM LINK OPEN ----

btnOpenStream.onclick = () => {
  if (!streamLinkInput.value) return;
  window.open(streamLinkInput.value, "_blank");
};
