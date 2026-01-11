// =====================================
//  REBEL HOST APP.JS
// =====================================
const socket = io({ autoConnect: false });

// elements
const $ = id => document.getElementById(id);
const nameInput       = $('nameInput');
const roomInput       = $('roomInput');
const joinBtn         = $('joinBtn');
const leaveBtn        = $('leaveBtn');
const startCallBtn    = $('startCallBtn');
const startStreamBtn  = $('startStreamBtn');
const shareScreenBtn  = $('shareScreenBtn');
const hangupBtn       = $('hangupBtn');
const toggleCamBtn    = $('toggleCamBtn');
const toggleMicBtn    = $('toggleMicBtn');
const openStreamBtn   = $('openStreamBtn');
const streamLinkInput = $('streamLinkInput');
const signalStatus    = $('signalStatus');
const roomInfo        = $('roomInfo');
const userListEl      = $('userList');
const peerTilesEl     = $('peerTiles');
const localVideo      = $('localVideo');
const focusVideo      = $('focusVideo');
const focusLabel      = $('focusLabel');
const chatLog         = $('chatLog');
const chatInput       = $('chatInput');
const sendBtn         = $('sendBtn');
const fileInput       = $('fileInput');
const sendFileBtn     = $('sendFileBtn');
const fileNameLabel   = $('fileNameLabel');
const emojiStrip      = $('emojiStrip');

// state
let currentRoom   = null;
let userName      = null;
let localStream   = null;
let screenStream  = null;
let camEnabled    = true;
let micEnabled    = true;
let isScreenSharing = false;

const peers = {}; // id -> { pc, stream, name }
let focusedPeerId = null;

let streamRoom = null;
let streamPC   = null;
let streaming  = false; // <--- NEW: stream toggle

// ringing
let audioCtx        = null;
let ringOsc         = null;
let ringGain        = null;
let ringTimeoutId   = null;

// ICE config
const iceConfig = {
  iceServers: (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
    ? ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }]
};

// =====================================
// Helpers
// =====================================
function setSignal(ok) {
  signalStatus.textContent = ok ? 'Connected' : 'Disconnected';
  signalStatus.className   = ok ? 'status-dot status-connected'
                                : 'status-dot status-disconnected';
}

function addChatLine(name, text) {
  const div = document.createElement('div');
  div.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> ${text}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function getLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  return localStream;
}

function renderUsers(users) {
  userListEl.innerHTML = '';
  users.forEach(u => {
    const pill = document.createElement('div');
    pill.className = 'user-pill' + (u.id === socket.id ? ' you' : '');
    const label = document.createElement('span');
    label.textContent = u.id === socket.id ? `${u.name} (you)` : u.name;
    pill.appendChild(label);

    if (u.id !== socket.id) {
      const b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = 'Call';
      b.onclick = () => callPeer(u.id, u.name);
      pill.appendChild(b);
    }
    userListEl.appendChild(pill);
  });
}

// ========== Ringing ==========
function startRinging() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ringOsc) return; // already ringing

    ringOsc = audioCtx.createOscillator();
    ringGain = audioCtx.createGain();
    ringOsc.type = 'sine';
    ringOsc.frequency.value = 650; // simple beep
    ringGain.gain.value = 0.15;

    ringOsc.connect(ringGain).connect(audioCtx.destination);
    ringOsc.start();

    // safety stop after 6s
    if (ringTimeoutId) clearTimeout(ringTimeoutId);
    ringTimeoutId = setTimeout(stopRinging, 6000);
  } catch (e) {
    console.warn('Ringing error:', e);
  }
}

function stopRinging() {
  try {
    if (ringOsc) {
      ringOsc.stop();
      ringOsc.disconnect();
      ringOsc = null;
    }
    if (ringGain) {
      ringGain.disconnect();
      ringGain = null;
    }
    if (ringTimeoutId) {
      clearTimeout(ringTimeoutId);
      ringTimeoutId = null;
    }
  } catch (e) {
    console.warn('Stop ringing error:', e);
  }
}

// =====================================
// Peer connections
// =====================================
function createPeerConnection(peerId, peerName) {
  const pc = new RTCPeerConnection(iceConfig);

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.ontrack = ({ streams }) => {
    peers[peerId].stream = streams[0];
    buildPeerTile(peerId);
    if (!focusedPeerId) focusPeer(peerId);
    broadcastFocused();
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('webrtc-ice-call', { targetId: peerId, candidate: e.candidate });
    }
  };

  return pc;
}

function buildPeerTile(peerId) {
  const entry = peers[peerId];
  if (!entry || !entry.stream) return;

  let tile = document.getElementById(`peer_${peerId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `peer_${peerId}`;
    tile.className = 'peer-tile';
    tile.onclick = () => focusPeer(peerId);

    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    tile.appendChild(vid);

    const name = document.createElement('div');
    name.className = 'peer-name';
    name.textContent = entry.name;
    tile.appendChild(name);

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
  await getLocalStream();
  if (!peers[peerId]) peers[peerId] = { pc: null, stream: null, name: peerName };
  if (!peers[peerId].pc) peers[peerId].pc = createPeerConnection(peerId, peerName);

  const pc = peers[peerId].pc;

  // outgoing ring
  startRinging();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('webrtc-offer-call', { targetId: peerId, sdp: offer });
}

// =====================================
// Broadcast to viewers (stream)
// =====================================
async function broadcastFocused() {
  if (!currentRoom || !streaming) return;

  let stream = null;
  if (focusedPeerId && peers[focusedPeerId] && peers[focusedPeerId].stream) {
    stream = peers[focusedPeerId].stream;
  } else if (localStream) {
    stream = localStream;
  }
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
  socket.emit('webrtc-offer-stream', { sdp: offer, streamRoom });
}

// =====================================
// UI events
// =====================================
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

  await getLocalStream(); // cam on, but NOT streaming yet

  streamRoom = `stream-${room}`;
  streamLinkInput.value = `${location.origin}/view.html?room=${room}`;
};

leaveBtn.onclick = () => location.reload();

startCallBtn.onclick = async () => {
  await getLocalStream();
  startCallBtn.disabled = true;
  hangupBtn.disabled = false;
};

startStreamBtn.onclick = () => {
  streaming = !streaming;
  startStreamBtn.textContent = streaming ? 'Stop Stream' : 'Start Stream';

  if (!streaming) {
    if (streamPC) {
      try { streamPC.close(); } catch (e) {}
      streamPC = null;
    }
    return;
  }

  broadcastFocused();
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

  if (streamPC) {
    try { streamPC.close(); } catch (e) {}
    streamPC = null;
  }

  streaming = false;
  startStreamBtn.textContent = 'Start Stream';
  startCallBtn.disabled = false;
  hangupBtn.disabled = true;
  stopRinging();
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
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    if (localStream) {
      Object.values(peers).forEach(p => p.pc && switchTracks(p.pc, localStream));
      broadcastFocused();
    }
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

// chat + files
sendBtn.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  addChatLine(userName, text);
  socket.emit('chat-message', { room: currentRoom, name: userName, text });
};

emojiStrip.onclick = e => {
  if (e.target.classList.contains('emoji')) {
    chatInput.value += e.target.textContent;
  }
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
    socket.emit('file-share', {
      room: currentRoom,
      name: userName,
      filename: f.name,
      content: r.result
    });
  };
  r.readAsDataURL(f);
  fileInput.value = '';
  fileNameLabel.textContent = 'No file';
  sendFileBtn.disabled = true;
};

// =====================================
// Socket events
// =====================================
socket.on('connect', () => setSignal(true));
socket.on('disconnect', () => setSignal(false));

socket.on('room-users', renderUsers);

// incoming offer (ring here)
socket.on('webrtc-offer-call', async ({ fromId, sdp }) => {
  // incoming ring
  startRinging();

  await getLocalStream();
  const peerName = '[Peer]';
  if (!peers[fromId]) peers[fromId] = { pc: null, stream: null, name: peerName };
  if (!peers[fromId].pc) peers[fromId].pc = createPeerConnection(fromId, peerName);
  const pc = peers[fromId].pc;

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);

  socket.emit('webrtc-answer-call', { targetId: fromId, sdp: ans });
  focusPeer(fromId);

  // stop ring once we’ve answered
  stopRinging();
});

socket.on('webrtc-answer-call', async ({ fromId, sdp }) => {
  const entry = peers[fromId];
  if (entry && entry.pc) {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
  // stop outgoing ring when they answer
  stopRinging();
});

socket.on('webrtc-ice-call', async ({ fromId, candidate }) => {
  const entry = peers[fromId];
  if (entry && entry.pc && candidate) {
    await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// viewer joined → (re)broadcast if streaming
socket.on('viewer-joined', () => {
  broadcastFocused();
});

// answers / ICE for stream
socket.on('webrtc-answer-stream', async ({ sdp }) => {
  if (streamPC) {
    await streamPC.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('webrtc-ice-stream', async ({ candidate }) => {
  if (streamPC && candidate) {
    await streamPC.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// chat + files in
socket.on('chat-message', ({ name, text }) => addChatLine(name, text));

socket.on('file-share', ({ name, filename, content }) => {
  const div = document.createElement('div');
  div.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> <a href="${content}" download="${filename}">📁 ${filename}</a>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// util
function switchTracks(pc, stream) {
  stream.getTracks().forEach(t => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === t.kind);
    if (sender) sender.replaceTrack(t);
  });
}
