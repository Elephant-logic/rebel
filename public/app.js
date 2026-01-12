// REBEL MESSENGER HOST / GUEST CLIENT
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// STREAM PC (for host → viewers)
let pc = null;
let isStreaming = false;
let broadcastStream = null;

// CALL PEERS (for multi-call, separate from stream)
const callPeers = {};      // { socketId: { pc, stream } }
const remoteStreams = {};  // { socketId: MediaStream }

// Local media
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let iceCandidatesQueue = []; // For stream PC early ICE

// Which feed goes out to public stream
// type: 'host' | 'user'
let streamSource = { type: 'host', id: null };

// ICE config (can be overridden via ICE_SERVERS in ice.js)
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? {
  iceServers: ICE_SERVERS
} : {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

// --- DOM ELEMENTS ---
const $ = id => document.getElementById(id);

// Connection
const nameInput       = $('nameInput');
const roomInput       = $('roomInput');
const joinBtn         = $('joinBtn');
const leaveBtn        = $('leaveBtn');
const signalStatus    = $('signalStatus');
const roomInfo        = $('roomInfo');

// Host Controls
const hostControls    = $('hostControls');
const lockRoomBtn     = $('lockRoomBtn');

// Media
const startCallBtn    = $('startCallBtn');
const startStreamBtn  = $('startStreamBtn');
const hangupBtn       = $('hangupBtn');   // GLOBAL hangup (stream + all calls)
const shareScreenBtn  = $('shareScreenBtn');
const toggleCamBtn    = $('toggleCamBtn');
const toggleMicBtn    = $('toggleMicBtn');
const settingsBtn     = $('settingsBtn');
const localVideo      = $('localVideo');
const remoteVideo     = $('remoteVideo');
const streamLinkInput = $('streamLinkInput');
const openStreamBtn   = $('openStreamBtn');

// Settings
const settingsPanel   = $('settingsPanel');
const audioSource     = $('audioSource');
const videoSource     = $('videoSource');
const closeSettingsBtn= $('closeSettingsBtn');

// Tabs
const tabChatBtn      = $('tabChatBtn');
const tabFilesBtn     = $('tabFilesBtn');
const tabUsersBtn     = $('tabUsersBtn');
const tabContentChat  = $('tabContentChat');
const tabContentFiles = $('tabContentFiles');
const tabContentUsers = $('tabContentUsers');

// Chat / Files / Users
const chatLog         = $('chatLog');
const chatInput       = $('chatInput');
const sendBtn         = $('sendBtn');
const emojiStrip      = $('emojiStrip');
const fileInput       = $('fileInput');
const sendFileBtn     = $('sendFileBtn');
const fileNameLabel   = $('fileNameLabel');
const fileLog         = $('fileLog');
const userList        = $('userList');

// --- UI HELPERS ---
function setSignal(connected) {
  if (!signalStatus) return;
  signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
  signalStatus.className = connected
    ? 'status-dot status-connected'
    : 'status-dot status-disconnected';
}

function switchTab(tab) {
  [tabChatBtn, tabFilesBtn, tabUsersBtn].forEach(b => b && b.classList.remove('active'));
  [tabContentChat, tabContentFiles, tabContentUsers].forEach(c => c && c.classList.remove('active'));

  if (tab === 'chat') {
    if (tabChatBtn) tabChatBtn.classList.add('active');
    if (tabContentChat) tabContentChat.classList.add('active');
  } else if (tab === 'files') {
    if (tabFilesBtn) tabFilesBtn.classList.add('active');
    if (tabContentFiles) tabContentFiles.classList.add('active');
  } else if (tab === 'users') {
    if (tabUsersBtn) tabUsersBtn.classList.add('active');
    if (tabContentUsers) tabContentUsers.classList.add('active');
  }
}
if (tabChatBtn)  tabChatBtn.addEventListener('click', () => switchTab('chat'));
if (tabFilesBtn) tabFilesBtn.addEventListener('click', () => switchTab('files'));
if (tabUsersBtn) tabUsersBtn.addEventListener('click', () => switchTab('users'));

function updateHangupState() {
  if (!hangupBtn) return;
  const hasCalls = Object.keys(callPeers).length > 0;
  hangupBtn.disabled = !isStreaming && !hasCalls;
}

// --- SETTINGS / DEVICES ---
async function getDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInput = devices.filter(d => d.kind === 'audioinput');
    const videoInput = devices.filter(d => d.kind === 'videoinput');

    if (audioSource) {
      audioSource.innerHTML = audioInput.map(d =>
        `<option value="${d.deviceId}">${d.label || 'Mic ' + d.deviceId.slice(0,5)}</option>`
      ).join('');
    }
    if (videoSource) {
      videoSource.innerHTML = videoInput.map(d =>
        `<option value="${d.deviceId}">${d.label || 'Cam ' + d.deviceId.slice(0,5)}</option>`
      ).join('');
    }
  } catch (e) {
    console.error('getDevices error:', e);
  }
}

async function switchMedia() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  const audioId = audioSource ? audioSource.value : undefined;
  const videoId = videoSource ? videoSource.value : undefined;

  const constraints = {
    audio: { deviceId: audioId ? { exact: audioId } : undefined },
    video: { deviceId: videoId ? { exact: videoId } : undefined }
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.muted = true;
    }

    // If streaming, swap tracks in stream PC
    if (pc) {
      const videoTrack = localStream.getVideoTracks()[0];
      const audioTrack = localStream.getAudioTracks()[0];
      const senders = pc.getSenders();

      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');

      if (videoSender && videoTrack) videoSender.replaceTrack(videoTrack);
      if (audioSender && audioTrack) audioSender.replaceTrack(audioTrack);
    }
  } catch (e) {
    console.error("Switch media error:", e);
  }
}

if (settingsBtn) settingsBtn.addEventListener('click', async () => {
  if (!settingsPanel) return;
  settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
  if (settingsPanel.style.display === 'block') await getDevices();
});
if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => {
  if (!settingsPanel) return;
  settingsPanel.style.display = 'none';
  switchMedia();
});

// --- USER LIST & ADMIN ---
function renderUserList(users, ownerId) {
  if (!userList) return;
  userList.innerHTML = '';

  iAmHost = (myId === ownerId);
  if (hostControls) {
    hostControls.style.display = iAmHost ? 'block' : 'none';
  }

  users.forEach(u => {
    const isMe = (u.id === myId);
    const isOwner = (u.id === ownerId);

    const div = document.createElement('div');
    div.className = isMe ? 'user-item is-me' : 'user-item';

    const displayName = isOwner ? `👑 ${u.name}` : u.name;

    let actions = '';
    if (!isMe) {
      // Call bell
      actions += `<button onclick="ringUser('${u.id}')" class="action-btn ring">🔔</button>`;
      // Per-user hangup (only this call)
      actions += `<button onclick="endPeerCall('${u.id}')" class="action-btn hang">⛔</button>`;
      if (iAmHost) {
        // Make them live on stream
        actions += `<button onclick="makeLive('${u.id}')" class="action-btn live">🎥</button>`;
        // Kick
        actions += `<button onclick="kickUser('${u.id}')" class="action-btn kick">🦵</button>`;
      }
    } else if (iAmHost) {
      // Host can select self as live
      actions += `<button onclick="makeLive('host')" class="action-btn live">🎥</button>`;
    }

    div.innerHTML = `
      <span>
        <span style="font-weight:bold; color: ${isMe ? 'var(--accent)' : 'inherit'}">
          ${displayName} ${isMe ? '(You)' : ''}
        </span>
      </span>
      <div class="user-actions">
        ${actions}
      </div>
    `;
    userList.appendChild(div);
  });

  updateHangupState();
}

// ring + start call
window.ringUser = async (id) => {
  socket.emit('ring-user', id);
  if (currentRoom) {
    try {
      await callPeer(id);
    } catch (e) {
      console.error('Error starting call after ring:', e);
    }
  }
};

window.kickUser = (id) => {
  if (confirm('Kick this user?')) socket.emit('kick-user', id);
};

// makeLive (no “must be in call” check)
window.makeLive = async function(target) {
  if (!iAmHost) return;

  if (target === 'host') {
    streamSource = { type: 'host', id: null };
    appendChat('System', 'You are now the live stream source.', Date.now(), false, false);
  } else {
    streamSource = { type: 'user', id: target };
    appendChat('System', `User is now the live stream source: ${target}`, Date.now(), false, false);
  }

  if (isStreaming) {
    try {
      await startBroadcast();
    } catch (e) {
      console.error('Error switching live source:', e);
    }
  }
};

// --- STREAM WEBRTC (host → viewers) ---

function createStreamPC() {
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = new RTCPeerConnection(iceConfig);
  iceCandidatesQueue = [];

  pc.onicecandidate = e => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
    }
  };

  pc.ontrack = () => {};
  pc.onconnectionstatechange = () => {
    console.log("Stream PC state:", pc.connectionState);
  };

  return pc;
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.muted = true;
    }
  } catch (e) {
    console.error("Media Error", e);
  }
  return localStream;
}

// Decide which stream we broadcast (host cam or a remote caller)
async function getBroadcastStream() {
  if (streamSource.type === 'user' && streamSource.id && remoteStreams[streamSource.id]) {
    const src = remoteStreams[streamSource.id];
    const out = new MediaStream();
    src.getVideoTracks().forEach(t => out.addTrack(t));
    src.getAudioTracks().forEach(t => out.addTrack(t));
    return out;
  }

  const hostStream = await ensureLocalStream();
  return hostStream;
}

async function startBroadcast() {
  if (!currentRoom) return alert('Join a room first');

  if (!pc) createStreamPC();

  const baseStream = isScreenSharing && screenStream
    ? screenStream
    : await getBroadcastStream();

  broadcastStream = baseStream;

  pc.getSenders().forEach(s => pc.removeTrack(s));
  broadcastStream.getTracks().forEach(t => pc.addTrack(t, broadcastStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });

  isStreaming = true;
  if (startStreamBtn) {
    startStreamBtn.disabled = true;
    startStreamBtn.textContent = 'Streaming…';
  }
  updateHangupState();
}

async function reofferStream() {
  if (!pc || !isStreaming) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  } catch (e) {
    console.error('reofferStream error:', e);
  }
}

socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    if (startStreamBtn) startStreamBtn.textContent = 'In Stream';
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  const ice = new RTCIceCandidate(candidate);
  if (!pc || !pc.remoteDescription) {
    iceCandidatesQueue.push(ice);
  } else {
    try {
      await pc.addIceCandidate(ice);
    } catch (e) {
      console.error('Stream ICE error:', e);
    }
  }
});

// --- SOCKET CONNECTION / ROOM EVENTS ---
socket.on('connect', () => {
  setSignal(true);
  myId = socket.id;
});
socket.on('disconnect', () => setSignal(false));

socket.on('role', ({ isHost }) => {
  iAmHost = !!isHost;
});

socket.on('room-update', ({ users, ownerId, locked }) => {
  renderUserList(users, ownerId);
  if (lockRoomBtn) {
    lockRoomBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
    lockRoomBtn.onclick = () => socket.emit('lock-room', !locked);
  }
});

socket.on('kicked', () => {
  alert('You have been kicked from the room.');
  window.location.reload();
});

socket.on('ring-alert', ({ from }) => {
  alert(`🔔 ${from} is calling you!`);
});

socket.on('room-error', (msg) => {
  alert(msg);
  if (joinBtn) joinBtn.disabled = false;
  if (leaveBtn) leaveBtn.disabled = true;
});

socket.on('user-joined', ({ id, name }) => {
  if (id !== myId) appendChat('System', `${name} joined.`, Date.now(), false, false);
  if (iAmHost && isStreaming) {
    reofferStream().catch(console.error);
  }
});

// --- JOIN / LEAVE ---
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput.value.trim();
    if (!room) return alert('Enter room');
    currentRoom = room;
    userName = nameInput.value.trim() || 'Anon';

    socket.connect();
    socket.emit('join-room', { room: currentRoom, name: userName });

    joinBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = false;
    if (roomInfo) roomInfo.textContent = `Room: ${room}`;

    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.search = `?room=${encodeURIComponent(room)}`;
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}
if (leaveBtn) leaveBtn.addEventListener('click', () => window.location.reload());

// STREAM BUTTON
if (startStreamBtn) {
  startStreamBtn.addEventListener('click', () => startBroadcast().catch(console.error));
}

// 🔴 GLOBAL HANG UP: end STREAM + ALL ACTIVE CALLS
if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    // 1) End stream
    if (pc) {
      try { pc.close(); } catch (e) {}
    }
    pc = null;
    isStreaming = false;

    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
    }
    screenStream = null;
    isScreenSharing = false;
    if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';

    if (startStreamBtn) {
      startStreamBtn.disabled = false;
      startStreamBtn.textContent = 'Start Stream';
    }

    // 2) End all calls
    Object.keys(callPeers).forEach(id => {
      endPeerCall(id);
    });

    updateHangupState();
  });
}

// --- SCREEN SHARE ---
if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert('Join room first');
    await ensureLocalStream();

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = screenStream.getVideoTracks()[0];
        if (pc) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(track);
        }
        if (localVideo) localVideo.srcObject = screenStream;
        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';
        track.onended = () => stopScreenShare();
      } catch (e) { console.error(e); }
    } else {
      stopScreenShare();
    }
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;

  if (localStream && pc) {
    const camTrack = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(camTrack);
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// --- TOGGLES ---
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const v = localStream.getVideoTracks()[0];
    v.enabled = !v.enabled;

    if (!v.enabled) {
      toggleCamBtn.textContent = 'Camera On';
      if (localVideo) localVideo.srcObject = null;
    } else {
      toggleCamBtn.textContent = 'Camera Off';
      if (localVideo) localVideo.srcObject = localStream;
    }
  });
}
if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const a = localStream.getAudioTracks()[0];
    a.enabled = !a.enabled;
    toggleMicBtn.textContent = a.enabled ? 'Mute' : 'Unmute';
  });
}
if (openStreamBtn) {
  openStreamBtn.addEventListener('click', () => {
    if (streamLinkInput && streamLinkInput.value) window.open(streamLinkInput.value, '_blank');
  });
}

// --- CHAT & FILES ---
function appendChat(name, text, ts = Date.now(), isOwner = false, fromViewer = false) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let nameHtml = `<strong>${name}</strong>`;
  if (name === 'You') nameHtml = `<span style="color:#4af3a3">${name}</span>`;
  else if (isOwner || name.includes('👑')) nameHtml = `<span style="color:#ffae00">👑 ${name.replace('👑','')}</span>`;

  const tagText = fromViewer ? 'STREAM' : 'ROOM';
  const tag = `<span style="background:#333;padding:2px 6px;border-radius:999px;font-size:0.65rem;margin-right:6px;color:#ccc;">${tagText}</span>`;

  line.innerHTML = `${tag}${nameHtml} <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

socket.on('chat-message', (data) => {
  appendChat(data.name, data.text, data.ts, data.isOwner, data.fromViewer);
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('chat-message', { room: currentRoom, name: userName, text, fromViewer: false });
  appendChat('You', text, Date.now(), false, false);
  chatInput.value = '';
}
if (sendBtn)   sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

if (emojiStrip) {
  emojiStrip.addEventListener('click', e => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

// Files
if (fileInput && sendFileBtn) {
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (fileNameLabel) fileNameLabel.textContent = file ? file.name : 'No file';
    sendFileBtn.disabled = !file;
  });
  sendFileBtn.addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file || !currentRoom) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      socket.emit('file-share', {
        room: currentRoom,
        name: userName,
        fileName: file.name,
        fileType: file.type,
        fileData: base64
      });
      appendFileLog('You', file.name, `data:${file.type};base64,${base64}`);
      fileInput.value = '';
      if (fileNameLabel) fileNameLabel.textContent = 'No file';
      sendFileBtn.disabled = true;
      switchTab('files');
    };
    reader.readAsDataURL(file);
  });
}
function appendFileLog(name, fileName, href) {
  if (!fileLog) return;
  const item = document.createElement('div');
  item.className = 'file-item';
  item.innerHTML = `
    <div>
      <div style="font-weight:bold; color:var(--accent);">${fileName}</div>
      <div style="font-size:0.7rem; color:var(--muted);">From: ${name}</div>
    </div>
    <a href="${href}" download="${fileName}" class="btn small primary">Download</a>
  `;
  fileLog.appendChild(item);
  appendChat(name, `Shared a file: ${fileName} (See Files tab)`, Date.now(), false, false);
}
socket.on('file-share', ({ name, fileName, fileType, fileData }) => {
  appendFileLog(name, fileName, `data:${fileType};base64,${fileData}`);
});

/* ======================================================
   CALL SECTION (separate from stream)
   ====================================================== */

if (startCallBtn) {
  startCallBtn.addEventListener('click', () => {
    if (!currentRoom) return alert('Join a room first');
    alert('Use the 🔔 next to each name to start calls.');
  });
}

function createCallPC(targetId) {
  const cp = new RTCPeerConnection(iceConfig);

  cp.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('call-ice', { targetId, candidate: e.candidate });
    }
  };

  cp.ontrack = (event) => {
    const incomingStream = event.streams[0];

    // show last active caller in remoteVideo for now
    if (remoteVideo) remoteVideo.srcObject = incomingStream;

    // remember this remote stream for broadcast selection
    remoteStreams[targetId] = incomingStream;

    if (!callPeers[targetId]) callPeers[targetId] = {};
    callPeers[targetId].stream = incomingStream;

    // ⚡ NEW: if this user is LIVE and we are already streaming,
    // restart broadcast so viewers see their cam as soon as it arrives
    if (isStreaming && streamSource.type === 'user' && streamSource.id === targetId) {
      startBroadcast().catch(console.error);
    }
  };

  cp.onconnectionstatechange = () => {
    console.log(`Call PC ${targetId} state:`, cp.connectionState);
  };

  if (!callPeers[targetId]) callPeers[targetId] = {};
  callPeers[targetId].pc = cp;
  return cp;
}

// Call a specific peer
async function callPeer(targetId) {
  const stream = await ensureLocalStream();
  const cp = createCallPC(targetId);

  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const offer = await cp.createOffer();
  await cp.setLocalDescription(offer);

  socket.emit('call-offer', { targetId, offer });

  if (startCallBtn) startCallBtn.textContent = 'In Call';
  updateHangupState();
}

// Incoming call
socket.on('incoming-call', ({ from, name, offer }) => {
  const ok = confirm(`${name} is calling. Accept?`);
  if (!ok) {
    socket.emit('call-reject', { targetId: from });
    return;
  }
  acceptCall(from, offer).catch(console.error);
});

// Accept call
async function acceptCall(from, offer) {
  const stream = await ensureLocalStream();
  const cp = createCallPC(from);

  await cp.setRemoteDescription(new RTCSessionDescription(offer));
  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const answer = await cp.createAnswer();
  await cp.setLocalDescription(answer);

  socket.emit('call-answer', { targetId: from, answer });

  if (startCallBtn) startCallBtn.textContent = 'In Call';
  updateHangupState();
}

// Call answer
socket.on('call-answer', async ({ from, answer }) => {
  const peer = callPeers[from];
  if (!peer || !peer.pc) return;
  await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
});

// Call ICE
socket.on('call-ice', ({ from, candidate }) => {
  const peer = callPeers[from];
  if (!peer || !peer.pc) return;
  peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// Per-peer end (local)
function endPeerCall(id, fromGlobal = false) {
  const peer = callPeers[id];

  if (peer && peer.stream && remoteVideo && remoteVideo.srcObject === peer.stream) {
    remoteVideo.srcObject = null;
  }

  if (peer && peer.pc) {
    try { peer.pc.close(); } catch (e) {}
  }
  delete callPeers[id];
  delete remoteStreams[id];

  if (!fromGlobal) {
    socket.emit('call-end', { targetId: id });
  }

  if (Object.keys(callPeers).length === 0) {
    if (startCallBtn) startCallBtn.textContent = 'Start Call';
  }
  updateHangupState();
}
window.endPeerCall = endPeerCall;

// Remote end
socket.on('call-end', ({ from }) => {
  const peer = callPeers[from];

  if (peer && peer.stream && remoteVideo && remoteVideo.srcObject === peer.stream) {
    remoteVideo.srcObject = null;
  }

  if (peer && peer.pc) {
    try { peer.pc.close(); } catch (e) {}
  }
  delete callPeers[from];
  delete remoteStreams[from];

  if (Object.keys(callPeers).length === 0) {
    if (startCallBtn) startCallBtn.textContent = 'Start Call';
  }
  updateHangupState();
});

// Reject
socket.on('call-reject', ({ from }) => {
  console.log('Call rejected by', from);
  const peer = callPeers[from];
  if (peer && peer.pc) {
    try { peer.pc.close(); } catch (e) {}
  }
  delete callPeers[from];
  delete remoteStreams[from];

  if (Object.keys(callPeers).length === 0) {
    if (startCallBtn) startCallBtn.textContent = 'Start Call';
  }
  updateHangupState();
});
