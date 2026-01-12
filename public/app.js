// app.js – room app: chat + files + multi calls + host-only stream

const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let myId = null;
let myRole = 'guest'; // 'host' / 'guest' (derived from hostId)
let hostId = null;

// STREAM (host → viewer)
let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// ROOM CALLS
const peers = {};     // { socketId: { name, tile, videoEl } }
const callPCs = {};   // { socketId: RTCPeerConnection }

// ROOM LOCK
let isRoomLocked = false;

// INCOMING CALL STATE
let pendingCall = null;

// ICE config (overridable from ice.js)
const iceConfig =
  typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length
    ? { iceServers: ICE_SERVERS }
    : {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const nameInput = $('nameInput');
const roomInput = $('roomInput');

const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const lockRoomBtn = $('lockRoomBtn');

const startCallBtn = $('startCallBtn');
const startCallAllBtn = $('startCallAllBtn');
const hangupBtn = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');

const localVideo = $('localVideo');
const remoteVideo = $('remoteVideo');
const peerTiles = $('peerTiles');

const streamLinkRow = $('streamLinkRow');
const streamLinkInput = $('streamLinkInput');
const openStreamBtn = $('openStreamBtn');

const signalStatus = $('signalStatus');
const roomInfo = $('roomInfo');

const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const emojiStrip = $('emojiStrip');
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');
const userList = $('userList');

// incoming call bar
const incomingCallBar = $('incomingCallBar');
const incomingCallText = $('incomingCallText');
const acceptCallBtn = $('acceptCallBtn');
const rejectCallBtn = $('rejectCallBtn');

// chat-side viewer for shared view
const chatSideVideo = $('chatSideVideo');

// ---------- Helpers ----------
function setSignal(connected) {
  if (!signalStatus) return;
  signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
  signalStatus.className = connected
    ? 'status-dot status-connected'
    : 'status-dot status-disconnected';
}

function appendChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  const who =
    name === 'You'
      ? `<span style="color:#4af3a3">${name}</span>`
      : name === 'System'
      ? `<span style="color:#9ba3c0">${name}</span>`
      : `<strong>${name}</strong>`;
  line.innerHTML = `${who} <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  userName = (nameInput && nameInput.value.trim()) || 'Host';
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });
  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
  }
  return localStream;
}

// Host vs guest UI – driven by myRole (which now follows hostId)
function applyRoleUI() {
  const isHost = myRole === 'host';

  const hostButtons = [
    startCallBtn,
    startCallAllBtn,
    shareScreenBtn,
    hangupBtn,
    lockRoomBtn
  ];

  hostButtons.forEach((btn) => {
    if (!btn) return;
    btn.style.display = isHost ? '' : 'none';
  });

  if (lockRoomBtn) lockRoomBtn.disabled = !isHost;

  if (streamLinkRow) {
    streamLinkRow.style.display = isHost ? '' : 'none';
  }
}

// hide host stuff by default until we know real host
applyRoleUI();

// incoming call UI
function showIncomingCall(fromName) {
  if (!incomingCallBar) return;
  incomingCallText.textContent = `Incoming call from ${fromName || 'guest'}…`;
  incomingCallBar.style.display = 'flex';
}

function hideIncomingCall() {
  if (!incomingCallBar) return;
  incomingCallBar.style.display = 'none';
  pendingCall = null;
}

// ---------- STREAM / BROADCAST (host → view.html) ----------
function createHostPC() {
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
  }
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (
      pc.connectionState === 'failed' ||
      pc.connectionState === 'disconnected'
    ) {
      console.warn('Host PC state:', pc.connectionState);
    }
  };

  return pc;
}

async function startBroadcast() {
  if (!currentRoom) {
    alert('Join a room first');
    return;
  }
  if (myRole !== 'host') {
    console.warn('Only host can start stream');
    return;
  }

  const stream =
    (isScreenSharing && screenStream) || (await ensureLocalStream());

  createHostPC();

  pc.getSenders().forEach((s) => pc.removeTrack(s));
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('webrtc-offer', {
    room: currentRoom,
    sdp: offer
  });

  if (startCallBtn) {
    startCallBtn.disabled = true;
    startCallBtn.textContent = 'Streaming…';
  }
  if (hangupBtn) hangupBtn.disabled = false;
}

function stopBroadcast() {
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
    pc = null;
  }
  if (!Object.keys(callPCs).length && localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    if (localVideo) localVideo.srcObject = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';

  if (startCallBtn) {
    startCallBtn.disabled = false;
    startCallBtn.textContent = 'Start Stream';
  }
  if (hangupBtn) hangupBtn.disabled = true;
}

// when someone joins, track them & re-offer stream if host is streaming
socket.on('user-joined', ({ id, name }) => {
  if (id && name && id !== myId) {
    if (!peers[id]) peers[id] = { name };
    renderUserList();
  }
  if (myRole === 'host' && (localStream || screenStream) && currentRoom) {
    startBroadcast().catch(console.error);
  }
});

socket.on('user-left', ({ id }) => {
  if (id && peers[id]) {
    appendChat('System', `${peers[id].name || 'Guest'} left the room`);
    detachPeer(id);
    delete peers[id];
    renderUserList();
  }
});

socket.on('webrtc-answer', async ({ sdp }) => {
  if (!pc || !sdp) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (e) {
    console.error('Host setRemoteDescription error:', e);
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Host ICE add error:', e);
  }
});

// ---------- ROOM LOCK & ROLES ----------
function updateLockButton() {
  if (!lockRoomBtn) return;
  lockRoomBtn.textContent = isRoomLocked ? 'Unlock Room' : 'Lock Room';
}

socket.on('room-locked', ({ room, locked }) => {
  if (!currentRoom || room !== currentRoom) return;
  isRoomLocked = !!locked;
  updateLockButton();
  appendChat(
    'System',
    locked ? 'Room locked – no new joins.' : 'Room unlocked – new joins allowed.'
  );
});

// REAL host / role is driven from this
socket.on('host-info', ({ room, hostId: hid }) => {
  if (!currentRoom || room !== currentRoom) return;
  hostId = hid || null;

  // derive myRole purely from hostId
  if (!hostId) {
    myRole = 'guest';
  } else {
    myRole = myId && myId === hostId ? 'host' : 'guest';
  }

  applyRoleUI();
  renderUserList();
});

// role-assigned is now just informational; host-info is the truth
socket.on('role-assigned', ({ room, role }) => {
  if (!room || room !== currentRoom) return;
  appendChat(
    'System',
    role === 'host'
      ? 'Server thinks you are host – waiting for confirmation from host-info…'
      : 'You joined as guest.'
  );
});

socket.on('host-left', ({ room }) => {
  if (!room || room !== currentRoom) return;
  appendChat('System', 'Host left this room.');
});

// ---------- MULTI-CALL (ROOM) ----------
function createCallPCForPeer(peerId) {
  const pcCall = new RTCPeerConnection(iceConfig);
  callPCs[peerId] = pcCall;

  if (localStream) {
    localStream.getTracks().forEach((t) => pcCall.addTrack(t, localStream));
  }

  pcCall.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('call-ice-candidate', {
        room: currentRoom,
        targetId: peerId,
        candidate: e.candidate
      });
    }
  };

  pcCall.ontrack = (event) => {
    const stream = event.streams[0];
    attachPeerStream(peerId, stream);
    if (remoteVideo) remoteVideo.srcObject = stream;
    if (chatSideVideo) chatSideVideo.srcObject = stream;
  };

  pcCall.onconnectionstatechange = () => {
    if (
      pcCall.connectionState === 'failed' ||
      pcCall.connectionState === 'disconnected' ||
      pcCall.connectionState === 'closed'
    ) {
      detachPeer(peerId);
      delete callPCs[peerId];
    }
  };

  return pcCall;
}

function ensurePeerTile(peerId) {
  if (!peerTiles || !peers[peerId]) return null;
  if (peers[peerId].tile && peers[peerId].videoEl) return peers[peerId].videoEl;

  const tile = document.createElement('div');
  tile.className = 'peer-tile';
  tile.dataset.peerId = peerId;

  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;

  const nameDiv = document.createElement('div');
  nameDiv.className = 'peer-name';
  nameDiv.textContent = peers[peerId].name || 'Guest';

  tile.appendChild(v);
  tile.appendChild(nameDiv);
  peerTiles.appendChild(tile);

  tile.addEventListener('click', () => {
    if (peers[peerId] && peers[peerId].videoEl && remoteVideo) {
      remoteVideo.srcObject = peers[peerId].videoEl.srcObject;
      if (chatSideVideo) chatSideVideo.srcObject = peers[peerId].videoEl.srcObject;
    }
  });

  peers[peerId].tile = tile;
  peers[peerId].videoEl = v;
  return v;
}

function attachPeerStream(peerId, stream) {
  const v = ensurePeerTile(peerId);
  if (v) v.srcObject = stream;
}

function detachPeer(peerId) {
  const info = peers[peerId];
  if (!info) return;

  if (info.tile && info.tile.parentNode) {
    info.tile.parentNode.removeChild(info.tile);
  }
  if (info.videoEl && info.videoEl.srcObject) {
    info.videoEl.srcObject.getTracks().forEach((t) => t.stop());
  }
  info.tile = null;
  info.videoEl = null;
}

async function startCallWithPeer(peerId) {
  if (!currentRoom || !peers[peerId]) return;
  await ensureLocalStream();

  let pcCall = callPCs[peerId];
  if (!pcCall) pcCall = createCallPCForPeer(peerId);

  const offer = await pcCall.createOffer();
  await pcCall.setLocalDescription(offer);

  socket.emit('call-offer', {
    room: currentRoom,
    targetId: peerId,
    sdp: offer
  });

  appendChat('System', `Calling ${peers[peerId].name || 'guest'}…`);
}

async function callEveryone() {
  const ids = Object.keys(peers).filter((id) => id !== myId);
  if (!ids.length) {
    alert('No one else in room to call.');
    return;
  }
  for (const peerId of ids) {
    await startCallWithPeer(peerId);
  }
}

function endCallWithPeer(peerId) {
  const info = peers[peerId];
  const pcCall = callPCs[peerId];

  if (pcCall) {
    try {
      pcCall.close();
    } catch (e) {}
    delete callPCs[peerId];
  }

  detachPeer(peerId);

  if (info) {
    appendChat('System', `Call ended with ${info.name || 'guest'}`);
  }
}

// ----- incoming call handling (ANSWER / REJECT) -----
socket.on('call-offer', (data) => {
  const { fromId, name, sdp } = data || {};
  if (!currentRoom || !fromId || !sdp) return;

  if (!peers[fromId]) peers[fromId] = { name: name || 'Guest' };
  renderUserList();

  pendingCall = { fromId, name, sdp };
  showIncomingCall(name);
});

socket.on('call-answer', async ({ fromId, sdp }) => {
  const pcCall = callPCs[fromId];
  if (!pcCall || !sdp) return;
  try {
    await pcCall.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (e) {
    console.error('call-answer setRemoteDescription error', e);
  }
});

socket.on('call-ice-candidate', async ({ fromId, candidate }) => {
  const pcCall = callPCs[fromId];
  if (!pcCall || !candidate) return;
  try {
    await pcCall.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('call ICE add error', e);
  }
});

socket.on('call-reject', () => {
  appendChat('System', 'Call was rejected.');
});

// Answer / Reject buttons
if (acceptCallBtn) {
  acceptCallBtn.addEventListener('click', async () => {
    if (!pendingCall) return;
    const { fromId, name, sdp } = pendingCall;
    hideIncomingCall();

    await ensureLocalStream();

    let pcCall = callPCs[fromId];
    if (!pcCall) pcCall = createCallPCForPeer(fromId);

    try {
      await pcCall.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pcCall.createAnswer();
      await pcCall.setLocalDescription(answer);

      socket.emit('call-answer', {
        room: currentRoom,
        targetId: fromId,
        sdp: answer
      });

      appendChat('System', `In call with ${name || 'guest'}`);
    } catch (e) {
      console.error('accept call error', e);
    }
  });
}

if (rejectCallBtn) {
  rejectCallBtn.addEventListener('click', () => {
    if (!pendingCall) return;
    socket.emit('call-reject', {
      room: currentRoom,
      targetId: pendingCall.fromId
    });
    hideIncomingCall();
  });
}

// ---------- USER LIST ----------
function renderUserList() {
  if (!userList) return;
  userList.innerHTML = '';

  // Self row
  if (myId) {
    const pill = document.createElement('div');
    pill.className = 'user-pill';

    const left = document.createElement('span');
    let label = userName || 'You';
    if (hostId && myId === hostId) {
      label += ' 👑';
    }
    left.textContent = label;

    pill.appendChild(left);
    userList.appendChild(pill);
  }

  const ids = Object.keys(peers).filter((id) => id !== myId);

  if (!ids.length && !myId) {
    userList.innerHTML =
      '<div class="user-pill"><span>No users yet…</span></div>';
    return;
  }

  ids.forEach((id) => {
    const info = peers[id];
    const pill = document.createElement('div');
    pill.className = 'user-pill';

    const left = document.createElement('span');
    let label = info.name || id;
    if (hostId && id === hostId) label += ' 👑';
    left.textContent = label;

    const right = document.createElement('div');

    const callBtn = document.createElement('button');
    callBtn.className = 'btn';
    callBtn.textContent = 'Call';
    callBtn.addEventListener('click', () => {
      startCallWithPeer(id).catch(console.error);
    });

    const endBtn = document.createElement('button');
    endBtn.className = 'btn danger';
    endBtn.textContent = 'End';
    endBtn.style.marginLeft = '4px';
    endBtn.addEventListener('click', () => {
      endCallWithPeer(id);
    });

    right.appendChild(callBtn);
    right.appendChild(endBtn);
    pill.appendChild(left);
    pill.appendChild(right);
    userList.appendChild(pill);
  });
}

// ---------- JOIN / LEAVE ----------
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput && roomInput.value.trim();
    if (!room) return alert('Enter room');
    currentRoom = room;
    userName = (nameInput && nameInput.value.trim()) || 'Host';

    socket.connect();
    socket.emit('join-room', {
      room: currentRoom,
      name: userName,
      clientType: 'app' // IMPORTANT: only app clients can ever be host
    });

    joinBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = false;
    if (lockRoomBtn) lockRoomBtn.disabled = true;
    if (roomInfo) roomInfo.textContent = `Room: ${room}`;

    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.search = `?room=${encodeURIComponent(room)}`;
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    stopBroadcast();
    Object.keys(callPCs).forEach((id) => {
      try {
        callPCs[id].close();
      } catch (e) {}
      delete callPCs[id];
      detachPeer(id);
    });

    socket.disconnect();
    window.location.reload();
  });
}

// lock / unlock (host only)
if (lockRoomBtn) {
  lockRoomBtn.addEventListener('click', () => {
    if (!currentRoom || myRole !== 'host') return;
    isRoomLocked = !isRoomLocked;
    socket.emit('lock-room', { room: currentRoom, locked: isRoomLocked });
    updateLockButton();
  });
}

// ---------- STREAM BUTTONS ----------
if (startCallBtn) {
  startCallBtn.addEventListener('click', () => {
    startBroadcast().catch(console.error);
  });
}

if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    stopBroadcast();
  });
}

if (startCallAllBtn) {
  startCallAllBtn.addEventListener('click', () => {
    callEveryone().catch(console.error);
  });
}

if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert('Join a room first');
    if (myRole !== 'host') {
      console.warn('Only host can share screen');
      return;
    }
    await ensureLocalStream();
    if (!pc) await startBroadcast();

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });
        const track = screenStream.getVideoTracks()[0];
        const sender = pc
          .getSenders()
          .find((s) => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(track);
        if (localVideo) localVideo.srcObject = screenStream;
        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';
        track.onended = () => stopScreenShare();
      } catch (e) {
        console.error('Screen share error:', e);
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
    const sender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === 'video');
    if (sender && camTrack) sender.replaceTrack(camTrack);
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// ---------- CAM / MIC ----------
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', async () => {
    if (!localStream) await ensureLocalStream();
    const enabled = localStream.getVideoTracks().some((t) => t.enabled);
    localStream.getVideoTracks().forEach((t) => (t.enabled = !enabled));
    toggleCamBtn.textContent = enabled ? 'Camera On' : 'Camera Off';
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', async () => {
    if (!localStream) await ensureLocalStream();
    const enabled = localStream.getAudioTracks().some((t) => t.enabled);
    localStream.getAudioTracks().forEach((t) => (t.enabled = !enabled));
    toggleMicBtn.textContent = enabled ? 'Unmute' : 'Mute';
  });
}

// open viewer link
if (openStreamBtn) {
  openStreamBtn.addEventListener('click', () => {
    if (!streamLinkInput || !streamLinkInput.value) return;
    window.open(streamLinkInput.value, '_blank');
  });
}

// ---------- CHAT ----------
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

function sendChat() {
  if (!currentRoom || !chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', {
    room: currentRoom,
    name: userName,
    text
  });
  appendChat('You', text);
  chatInput.value = '';
}

if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
}
if (emojiStrip) {
  emojiStrip.addEventListener('click', (e) => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

// ---------- FILES ----------
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
        fileSize: file.size,
        fileData: base64
      });
      appendChat('You', `Sent file: ${file.name}`);
      fileInput.value = '';
      if (fileNameLabel) fileNameLabel.textContent = 'No file';
      sendFileBtn.disabled = true;
    };
    reader.readAsDataURL(file);
  });
}

socket.on('file-share', ({ name, fileName, fileType, fileData }) => {
  const href = `data:${fileType};base64,${fileData}`;
  const link = `<a href="${href}" download="${fileName}" style="color:#4af3a3">📁 ${fileName}</a>`;
  appendChat(name, `Sent file: ${link}`);
});

// ---------- SOCKET STATUS ----------
socket.on('connect', () => {
  myId = socket.id;
  setSignal(true);
  renderUserList();
});

socket.on('disconnect', () => {
  setSignal(false);
});
