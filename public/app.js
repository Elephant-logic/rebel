// =====================================
//  REBEL HOST — FULL FIXED APP.JS
//  (Multi-call + Broadcast + Auto Cam)
// =====================================

const socket = io({ autoConnect: false });

// Elements
const get = id => document.getElementById(id);
const nameInput = get('nameInput');
const roomInput = get('roomInput');
const joinBtn = get('joinBtn');
const leaveBtn = get('leaveBtn');
const startCallBtn = get('startCallBtn');
const shareScreenBtn = get('shareScreenBtn');
const hangupBtn = get('hangupBtn');
const toggleCamBtn = get('toggleCamBtn');
const toggleMicBtn = get('toggleMicBtn');
const openStreamBtn = get('openStreamBtn');
const streamLinkInput = get('streamLinkInput');
const signalStatus = get('signalStatus');
const roomInfo = get('roomInfo');
const userListEl = get('userList');
const peerTilesEl = get('peerTiles');
const localVideo = get('localVideo');
const focusVideo = get('focusVideo');
const focusLabel = get('focusLabel');
const chatLog = get('chatLog');
const chatInput = get('chatInput');
const sendBtn = get('sendBtn');
const fileInput = get('fileInput');
const sendFileBtn = get('sendFileBtn');
const fileNameLabel = get('fileNameLabel');
const emojiStrip = get('emojiStrip');

// State
let currentRoom = null;
let userName = null;
let localStream = null;
let screenStream = null;
let camEnabled = true;
let micEnabled = true;
let isScreenSharing = false;

// Multi-call peers
const peers = {}; // peerId -> { pc, stream, name }
let focusedPeerId = null;

// Broadcast streaming
let streamRoom = null;
let streamPC = null;

// ICE
const iceConfig = {
  iceServers: (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
    ? ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ========= Helpers =========

function updateSignal(ok) {
  signalStatus.textContent = ok ? 'Connected' : 'Disconnected';
  signalStatus.className = ok ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

function chatLine(name, text) {
  const div = document.createElement('div');
  div.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> ${text}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  return localStream;
}

function renderUserList(users) {
  userListEl.innerHTML = '';
  users.forEach(u => {
    const pill = document.createElement('div');
    pill.className = 'user-pill' + (u.id === socket.id ? ' you' : '');
    const txt = document.createElement('span');
    txt.textContent = u.id === socket.id ? `${u.name} (you)` : u.name;
    pill.appendChild(txt);
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

// ========= Peer Call Logic =========

function createPeerConnection(peerId, peerName) {
  const pc = new RTCPeerConnection(iceConfig);

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.ontrack = ({ streams }) => {
    peers[peerId].stream = streams[0];
    buildTile(peerId);
    if (!focusedPeerId) focusPeer(peerId);
    broadcastFocused();
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('webrtc-ice-call', {
        targetId: peerId,
        candidate: e.candidate
      });
    }
  };

  return pc;
}

function buildTile(peerId) {
  const entry = peers[peerId];
  if (!entry || !entry.stream) return;

  let tile = document.getElementById(`peer_${peerId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'peer-tile';
    tile.id = `peer_${peerId}`;
    tile.onclick = () => focusPeer(peerId);

    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true;
    tile.appendChild(v);

    const lbl = document.createElement('div');
    lbl.className = 'peer-name';
    lbl.textContent = entry.name;
    tile.appendChild(lbl);

    peerTilesEl.appendChild(tile);
  }
  tile.querySelector('video').srcObject = entry.stream;
}

function focusPeer(peerId) {
  const entry = peers[peerId];
  if (!entry || !entry.stream) return;
  focusedPeerId = peerId;
  focusVideo.srcObject = entry.stream;
  focusLabel.textContent = entry.name;
  broadcastFocused();
}

async function callPeer(peerId, peerName) {
  await ensureLocalStream();
  if (!peers[peerId]) peers[peerId] = { pc: null, stream: null, name: peerName };
  if (!peers[peerId].pc) peers[peerId].pc = createPeerConnection(peerId, peerName);

  const pc = peers[peerId].pc;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('webrtc-offer-call', { targetId: peerId, sdp: offer });
}

// ========= Broadcast Logic =========

async function broadcastFocused() {
  if (!currentRoom) return;
  if (!focusedPeerId && !localStream) return;

  const stream = focusedPeerId && peers[focusedPeerId] && peers[focusedPeerId].stream
    ? peers[focusedPeerId].stream
    : localStream;

  if (!stream) return;

  if (!streamRoom) streamRoom = `stream-${currentRoom}`;

  if (!streamPC) {
    streamPC = new RTCPeerConnection(iceConfig);
    streamPC.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('webrtc-ice-stream', {
          candidate: e.candidate,
          streamRoom
        });
      }
    };
  } else {
    streamPC.getSenders().forEach(s => streamPC.removeTrack(s));
  }

  stream.getTracks().forEach(t => streamPC.addTrack(t, stream));

  const offer = await streamPC.createOffer();
  await streamPC.setLocalDescription(offer);

  socket.emit('webrtc-offer-stream', {
    sdp: offer,
    streamRoom
  });
}

// ========= UI Events =========

joinBtn.onclick = async () => {
  const room = roomInput.value.trim();
  userName = nameInput.value.trim() || `User-${String(Math.random()).slice(2,6)}`;
  if (!room) return alert('Enter room');
  currentRoom = room;

  socket.connect();
  socket.emit('join-room', { room, name: userName });

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  roomInfo.textContent = `Room: ${room}`;

  await ensureLocalStream();          // <-- CAMERA COMES ON HERE
  broadcastFocused();                 // <-- start broadcast even with only you

  streamRoom = `stream-${room}`;
  streamLinkInput.value = `${location.origin}/view.html?room=${room}`;
};

leaveBtn.onclick = () => location.reload();

startCallBtn.onclick = async () => {
  await ensureLocalStream();
  startCallBtn.disabled = true;
  hangupBtn.disabled = false;
  broadcastFocused();
};

shareScreenBtn.onclick = async () => {
  if (!isScreenSharing) {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    isScreenSharing = true;
    Object.values(peers).forEach(p => p.pc && switchTracks(p.pc, screenStream));
    broadcastFocused();
    shareScreenBtn.textContent = 'Stop Screen';
  } else {
    isScreenSharing = false;
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    Object.values(peers).forEach(p => p.pc && switchTracks(p.pc, localStream));
    broadcastFocused();
    shareScreenBtn.textContent = 'Share Screen';
  }
};

toggleCamBtn.onclick = () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  toggleCamBtn.textContent = camEnabled ? 'Camera Off' : 'Camera On';
};

toggleMicBtn.onclick = () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  toggleMicBtn.textContent = micEnabled ? 'Mute' : 'Unmute';
};

openStreamBtn.onclick = () => {
  const url = streamLinkInput.value.trim();
  if (url) window.open(url, '_blank');
};

// ========= File/Chat =========

sendBtn.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatLine(userName, text);
  socket.emit('chat-message', { room: currentRoom, name: userName, text });
};

emojiStrip.onclick = e => {
  if (e.target.classList.contains('emoji')) chatInput.value += e.target.textContent;
};

fileInput.onchange = () => {
  const f = fileInput.files[0];
  fileNameLabel.textContent = f ? f.name : 'No file';
  sendFileBtn.disabled = !f;
};

sendFileBtn.onclick = () => {
  const f = fileInput.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    socket.emit('file-share', { room: currentRoom, name: userName, filename: f.name, content: r.result });
  };
  r.readAsDataURL(f);
  fileInput.value = '';
  fileNameLabel.textContent = 'No file';
  sendFileBtn.disabled = true;
};

// ========= Socket Events =========

socket.on('connect', () => updateSignal(true));
socket.on('disconnect', () => updateSignal(false));

socket.on('room-users', renderUserList);

socket.on('webrtc-offer-call', async ({ fromId, sdp }) => {
  await ensureLocalStream();
  const peerName = '[Peer]';
  if (!peers[fromId]) peers[fromId] = { pc: null, stream: null, name: peerName };
  if (!peers[fromId].pc) peers[fromId].pc = createPeerConnection(fromId, peerName);
  const pc = peers[fromId].pc;

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);

  socket.emit('webrtc-answer-call', { targetId: fromId, sdp: ans });
  focusPeer(fromId);
});

socket.on('webrtc-answer-call', async ({ fromId, sdp }) => {
  const entry = peers[fromId];
  if (entry && entry.pc) await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-call', async ({ fromId, candidate }) => {
  const entry = peers[fromId];
  if (entry && entry.pc && candidate) await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// viewer joins
socket.on('viewer-joined', () => broadcastFocused());

// viewer answers
socket.on('webrtc-answer-stream', async ({ sdp }) => {
  if (streamPC) await streamPC.setRemoteDescription(new RTCSessionDescription(sdp));
});

// viewer ICE
socket.on('webrtc-ice-stream', async ({ candidate }) => {
  if (streamPC && candidate) await streamPC.addIceCandidate(new RTCIceCandidate(candidate));
});

// chat/file in
socket.on('chat-message', ({ name, text }) => chatLine(name, text));

socket.on('file-share', ({ name, filename, content }) => {
  const div = document.createElement('div');
  div.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> <a href="${content}" download="${filename}">📁 ${filename}</a>`;
  chatLog.appendChild(div);
});

// ========= util =========

function switchTracks(pc, stream) {
  stream.getTracks().forEach(t => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === t.kind);
    if (sender) sender.replaceTrack(t);
  });
}
