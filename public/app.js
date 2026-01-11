// =======================
//  Rebel Host App Logic
// =======================

// Socket
const socket = io({ autoConnect: false });

// Elements
const getEl = id => document.getElementById(id);
const nameInput = getEl('nameInput');
const roomInput = getEl('roomInput');
const joinBtn = getEl('joinBtn');
const leaveBtn = getEl('leaveBtn');
const startCallBtn = getEl('startCallBtn');
const shareScreenBtn = getEl('shareScreenBtn');
const hangupBtn = getEl('hangupBtn');
const toggleCamBtn = getEl('toggleCamBtn');
const toggleMicBtn = getEl('toggleMicBtn');
const openStreamBtn = getEl('openStreamBtn');
const streamLinkInput = getEl('streamLinkInput');
const signalStatus = getEl('signalStatus');
const roomInfo = getEl('roomInfo');
const userListEl = getEl('userList');
const peerTilesEl = getEl('peerTiles');
const localVideo = getEl('localVideo');
const focusVideo = getEl('focusVideo');
const focusLabel = getEl('focusLabel');
const chatLog = getEl('chatLog');
const chatInput = getEl('chatInput');
const sendBtn = getEl('sendBtn');
const fileInput = getEl('fileInput');
const sendFileBtn = getEl('sendFileBtn');
const fileNameLabel = getEl('fileNameLabel');
const emojiStrip = getEl('emojiStrip');

// State
let currentRoom = null;
let userName = null;
let localStream = null;
let screenStream = null;
let broadcasting = false;
let isScreenSharing = false;
let camEnabled = true;
let micEnabled = true;

// Multi-call maps
const peers = {};     // peerId -> { pc, stream, name }
let focusedPeerId = null;

// Broadcast stream ID
let streamRoom = null;

// ICE config (from ice.js)
const iceConfig = {
  iceServers: (typeof ICE_SERVERS !== 'undefined' && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length)
    ? ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }]
};

// =======================
//  UTIL HELPERS
// =======================

function logChat(name, text) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderUserList(users) {
  userListEl.innerHTML = '';
  users.forEach(u => {
    const pill = document.createElement('div');
    pill.className = 'user-pill' + (u.id === socket.id ? ' you' : '');
    const label = document.createElement('span');
    label.textContent = u.id === socket.id ? `${u.name} (you)` : u.name;
    pill.appendChild(label);

    if (u.id !== socket.id) {
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = 'Call';
      btn.onclick = () => callPeer(u.id, u.name);
      pill.appendChild(btn);
    }
    userListEl.appendChild(pill);
  });
}

function updateSignalStatus(ok) {
  if (ok) {
    signalStatus.textContent = 'Connected';
    signalStatus.className = 'status-dot status-connected';
  } else {
    signalStatus.textContent = 'Disconnected';
    signalStatus.className = 'status-dot status-disconnected';
  }
}

// =======================
//  MEDIA SETUP
// =======================

async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    return localStream;
  } catch (err) {
    alert('Camera/Mic access failed: ' + err.message);
    throw err;
  }
}

function switchToStreamFor(pc, stream) {
  stream.getTracks().forEach(t => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === t.kind);
    if (sender) {
      sender.replaceTrack(t);
    }
  });
}

// =======================
//  PEER CONNECTIONS
// =======================

function createPeerConnection(peerId, peerName) {
  const pc = new RTCPeerConnection(iceConfig);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  // On remote track
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    peers[peerId].stream = stream;
    renderPeerTile(peerId);
    if (!focusedPeerId) focusPeer(peerId);
  };

  // ICE to peer
  pc.onicecandidate = ev => {
    if (ev.candidate) {
      socket.emit('webrtc-ice-call', {
        targetId: peerId,
        candidate: ev.candidate
      });
    }
  };

  return pc;
}

function renderPeerTile(peerId) {
  const existing = document.getElementById(`peer_${peerId}`);
  const entry = peers[peerId];
  if (!entry || !entry.stream) return;

  if (existing) {
    existing.querySelector('video').srcObject = entry.stream;
    return;
  }

  const tile = document.createElement('div');
  tile.className = 'peer-tile';
  tile.id = `peer_${peerId}`;
  tile.onclick = () => focusPeer(peerId);

  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;
  v.srcObject = entry.stream;
  tile.appendChild(v);

  const lbl = document.createElement('div');
  lbl.className = 'peer-name';
  lbl.textContent = entry.name || 'User';
  tile.appendChild(lbl);

  peerTilesEl.appendChild(tile);
}

function focusPeer(peerId) {
  const entry = peers[peerId];
  if (!entry || !entry.stream) return;
  focusedPeerId = peerId;
  focusVideo.srcObject = entry.stream;
  focusLabel.textContent = entry.name || 'Focused';
  broadcastFocusedStream();
}

// =======================
//  CALL ACTION
// =======================

async function callPeer(peerId, peerName) {
  await ensureLocalStream();
  if (!peers[peerId]) {
    peers[peerId] = { pc: null, stream: null, name: peerName };
  }
  if (!peers[peerId].pc) {
    peers[peerId].pc = createPeerConnection(peerId, peerName);
  }

  const pc = peers[peerId].pc;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('webrtc-offer-call', {
    targetId: peerId,
    sdp: offer,
    room: currentRoom
  });
}

// =======================
//  BROADCAST VIEWER STREAM
// =======================

async function broadcastFocusedStream() {
  if (!focusedPeerId) return;
  const entry = peers[focusedPeerId];
  if (!entry || !entry.stream) return;

  if (!streamRoom) {
    streamRoom = `stream-${currentRoom}`;
  }

  const bpc = new RTCPeerConnection(iceConfig);
  const stream = entry.stream;
  stream.getTracks().forEach(t => bpc.addTrack(t, stream));

  bpc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('webrtc-ice-stream', {
        candidate: e.candidate,
        streamRoom
      });
    }
  };

  const offer = await bpc.createOffer();
  await bpc.setLocalDescription(offer);

  socket.emit('webrtc-offer-stream', {
    sdp: offer,
    streamRoom
  });
}

// =======================
//  UI EVENTS
// =======================

joinBtn.onclick = () => {
  const room = roomInput.value.trim();
  userName = nameInput.value.trim() || `User-${String(Math.random()).slice(2,6)}`;
  if (!room) return alert('Enter room');
  currentRoom = room;
  socket.connect();
  socket.emit('join-room', { room, name: userName });
  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  roomInfo.textContent = `Room: ${room}`;

  // viewer link
  streamRoom = `stream-${room}`;
  const url = `${location.origin}/view.html?room=${room}`;
  streamLinkInput.value = url;
};

leaveBtn.onclick = () => location.reload();

openStreamBtn.onclick = () => {
  const url = streamLinkInput.value.trim();
  if (url) window.open(url, '_blank');
};

startCallBtn.onclick = async () => {
  await ensureLocalStream();
  startCallBtn.disabled = true;
  hangupBtn.disabled = false;
};

shareScreenBtn.onclick = async () => {
  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      isScreenSharing = true;
      Object.values(peers).forEach(p => p.pc && switchToStreamFor(p.pc, screenStream));
      shareScreenBtn.textContent = 'Stop Screen';
    } catch (e) {
      console.error(e);
    }
  } else {
    isScreenSharing = false;
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    if (localStream) {
      Object.values(peers).forEach(p => p.pc && switchToStreamFor(p.pc, localStream));
    }
    shareScreenBtn.textContent = 'Share Screen';
  }
};

hangupBtn.onclick = () => {
  Object.values(peers).forEach(p => p.pc && p.pc.close());
  for (const id in peers) delete peers[id];
  focusedPeerId = null;
  focusVideo.srcObject = null;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  startCallBtn.disabled = false;
  hangupBtn.disabled = true;
};

// CAM / MIC
toggleCamBtn.onclick = () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => (t.enabled = camEnabled));
  toggleCamBtn.textContent = camEnabled ? 'Camera Off' : 'Camera On';
};

toggleMicBtn.onclick = () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
  toggleMicBtn.textContent = micEnabled ? 'Mute' : 'Unmute';
};

// CHAT + EMOJI
sendBtn.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  logChat(userName, text);
  socket.emit('chat-message', {
    room: currentRoom,
    name: userName,
    text,
    ts: Date.now()
  });
};

emojiStrip.onclick = e => {
  if (e.target.classList.contains('emoji')) {
    chatInput.value += e.target.textContent;
  }
};

// FILE SHARE
fileInput.onchange = e => {
  const f = e.target.files[0];
  if (f) {
    fileNameLabel.textContent = f.name;
    sendFileBtn.disabled = false;
  }
};

sendFileBtn.onclick = () => {
  const f = fileInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('file-share', {
      room: currentRoom,
      name: userName,
      filename: f.name,
      content: reader.result
    });
  };
  reader.readAsDataURL(f);
  fileInput.value = '';
  fileNameLabel.textContent = 'No file';
  sendFileBtn.disabled = true;
};

// =======================
//  SOCKET SIGNALING HANDLERS
// =======================

socket.on('connect', () => updateSignalStatus(true));
socket.on('disconnect', () => updateSignalStatus(false));

socket.on('room-users', users => {
  renderUserList(users);
});

// CALL OFFER
socket.on('webrtc-offer-call', async ({ fromId, sdp }) => {
  await ensureLocalStream();
  const peerName = '[Peer]';
  if (!peers[fromId]) peers[fromId] = { pc: null, stream: null, name: peerName };
  if (!peers[fromId].pc) peers[fromId].pc = createPeerConnection(fromId, peerName);
  const pc = peers[fromId].pc;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.emit('webrtc-answer-call', {
    targetId: fromId,
    sdp: ans
  });
  focusPeer(fromId);
});

// CALL ANSWER
socket.on('webrtc-answer-call', async ({ fromId, sdp }) => {
  const entry = peers[fromId];
  if (entry && entry.pc) {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

// CALL ICE
socket.on('webrtc-ice-call', async ({ fromId, candidate }) => {
  const entry = peers[fromId];
  if (entry && entry.pc && candidate) {
    await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// VIEW STREAM (from viewers)
socket.on('viewer-joined', () => {
  broadcastFocusedStream();
});

// STREAM ANSWERS
socket.on('webrtc-answer-stream', async ({ sdp }) => {
  // viewer never sends media back; just ignore here
});

socket.on('webrtc-ice-stream', ({ candidate }) => {
  // viewer side ICE only affects broadcast peer connection creation
});

// CHAT IN
socket.on('chat-message', ({ name, text }) => {
  logChat(name, text);
});

// FILE IN
socket.on('file-share', ({ name, filename, content }) => {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> <a href="${content}" download="${filename}">📁 ${filename}</a>`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
});
