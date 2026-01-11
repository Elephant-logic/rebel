// HOST APP — CALL + STREAM + RING + FOCUS + SETTINGS
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';

// WebRTC per user
let peerMap = new Map(); // userId -> RTCPeerConnection

let localStream = null;
let screenStream = null;
let isScreenSharing = false;

let videoDevices = [];
let audioDevices = [];
let currentVideoIndex = 0;
let currentAudioIndex = 0;

let focusTarget = null; // who the viewer sees
let myId = null;

// ICE config
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// DOM
const $ = id => document.getElementById(id);

const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const startCallBtn = $('startCallBtn');
const startStreamBtn = $('startStreamBtn');
const hangupBtn = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const changeCamBtn = $('changeCamBtn');
const settingsBtn = $('settingsBtn');

const localVideo = $('localVideo');
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

let userListEl = null;
let lockBtn = null;

// ---------- SOCKET STATUS ----------
socket.on('connect', () => {
  myId = socket.id;
  signalStatus.textContent = 'Connected';
  signalStatus.classList.add('status-connected');
});
socket.on('disconnect', () => {
  signalStatus.textContent = 'Disconnected';
  signalStatus.classList.remove('status-connected');
});

// ---------- JOIN ROOM ----------
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    const name = $('nameInput').value.trim() || 'Host';
    if (!room) return alert("Enter room");

    currentRoom = room;
    userName = name;

    socket.connect();
    socket.emit('join-room', { room, name });

    joinBtn.disabled = true;
    leaveBtn.disabled = false;

    if (roomInfo) roomInfo.textContent = `Room: ${room}`;

    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.searchParams.set('room', room);
    streamLinkInput.value = url.toString();
  });
}

// ---------- LEAVE ----------
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    stopEverything();
    socket.disconnect();
    window.location.reload();
  });
}

// ---------- DEVICE ENUM ----------
async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  videoDevices = devices.filter(d => d.kind === 'videoinput');
  audioDevices = devices.filter(d => d.kind === 'audioinput');
}

// ---------- LOCAL PREVIEW ----------
async function ensureLocalStream(constraintsOverride) {
  const constraints = constraintsOverride || { video: true, audio: true };

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }

  localStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
  }

  updateAllOutgoingTracks();

  return localStream;
}

// ---------- START CALL (Preview Only) ----------
if (startCallBtn) {
  startCallBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert("Join room first");
    if (!localStream) {
      await refreshDevices();
      await ensureLocalStream();
      startCallBtn.textContent = "Stop Call Cam";
    } else {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      if (localVideo) localVideo.srcObject = null;
      startCallBtn.textContent = "Start Call";
    }
  });
}

// ---------- RING CALL ----------
socket.on('room-state', ({ hostId, locked, users }) => {
  const isHost = hostId === myId;
  renderUserList(users, hostId, isHost, locked);
});

// Host -> click on user -> sends ring
function callUser(userId) {
  socket.emit('call-user', { to: userId });
  appendChat("System", `📞 Calling ${userId}...`, Date.now());
}

// Receiver gets popup
socket.on('incoming-call', ({ from, fromName }) => {
  showIncomingCall(from, fromName);
});

// Receiver responds
function sendCallResponse(to, accepted) {
  socket.emit('call-response', { to, accepted });
}

socket.on('call-response', ({ from, accepted }) => {
  if (!accepted) {
    appendChat("System", `❌ ${from} rejected call`, Date.now());
  } else {
    appendChat("System", `✔ ${from} accepted call`, Date.now());
    createPeerForUser(from);
  }
});

// ---------- PEER CONNECTION PER USER ----------
function createPeerForUser(userId) {
  const pc = new RTCPeerConnection(iceConfig);
  peerMap.set(userId, pc);

  const stream = isScreenSharing ? screenStream : localStream;
  if (stream) {
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
  }

  pc.ontrack = (e) => handleRemoteTrack(userId, e.streams[0]);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  makeOffer(userId);

  return pc;
}

async function makeOffer(userId) {
  const pc = peerMap.get(userId);
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
}

socket.on('webrtc-answer', async ({ sdp }) => {
  for (const [, pc] of peerMap) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  for (const [, pc] of peerMap) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// ---------- REMOTE VIDEO HANDLING ----------
function handleRemoteTrack(userId, stream) {
  createTile(userId, stream);
}

function createTile(userId, stream) {
  const strip = ensureCallStrip();
  let tile = document.getElementById(`tile-${userId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'user-tile';
    tile.id = `tile-${userId}`;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="tile-controls">
        <button class="btn focus-btn">Focus</button>
      </div>
    `;
    strip.appendChild(tile);

    tile.querySelector('.focus-btn').onclick = () => setFocus(userId);
  }

  const video = tile.querySelector('video');
  video.srcObject = stream;
  video.muted = false;
}

// ---------- FOCUS ----------
function setFocus(userId) {
  focusTarget = userId;
  appendChat("System", `🎯 Focus: ${userId}`, Date.now());
}

// ---------- UPDATE STREAM TRACKS ----------
function updateAllOutgoingTracks() {
  for (const [, pc] of peerMap) {
    const stream = isScreenSharing ? screenStream : localStream;
    if (!stream) continue;
    const v = stream.getVideoTracks()[0];
    const a = stream.getAudioTracks()[0];
    pc.getSenders().forEach(sender => {
      if (sender.track && sender.track.kind === 'video' && v) sender.replaceTrack(v);
      if (sender.track && sender.track.kind === 'audio' && a) sender.replaceTrack(a);
    });
  }
}

// ---------- SCREEN SHARE ----------
if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!localStream) return alert('Start camera first');

    if (!pcMapCheck()) await refreshDevices();

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        isScreenSharing = true;
        shareScreenBtn.textContent = "Stop Screen";
        screenStream.getVideoTracks()[0].onended = stopScreenShare;
        updateAllOutgoingTracks();
      } catch (err) {
        console.error(err);
      }
    } else {
      stopScreenShare();
    }
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  isScreenSharing = false;
  shareScreenBtn.textContent = "Share Screen";
  updateAllOutgoingTracks();
}

// ---------- CHANGE CAM ----------
if (changeCamBtn) {
  changeCamBtn.addEventListener('click', async () => {
    await refreshDevices();
    if (!videoDevices.length) return alert('No cams');
    currentVideoIndex = (currentVideoIndex + 1) % videoDevices.length;
    const constraints = {
      video: { deviceId: { exact: videoDevices[currentVideoIndex].deviceId }},
      audio: audioDevices[currentAudioIndex] ? { deviceId: { exact: audioDevices[currentAudioIndex].deviceId }} : true
    };
    await ensureLocalStream(constraints);
  });
}

// ---------- SETTINGS ----------
if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

let settingsModal = null;
let videoSelect = null;
let audioSelect = null;
let applyBtn = null;
let closeBtn = null;

async function openSettings() {
  await refreshDevices();
  ensureSettingsModal();

  videoSelect.innerHTML = '';
  audioSelect.innerHTML = '';

  videoDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i+1}`;
    if (i === currentVideoIndex) opt.selected = true;
    videoSelect.appendChild(opt);
  });

  audioDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Mic ${i+1}`;
    if (i === currentAudioIndex) opt.selected = true;
    audioSelect.appendChild(opt);
  });

  settingsModal.style.display = 'flex';
}

function ensureSettingsModal() {
  if (settingsModal) return;
  settingsModal = document.createElement('div');
  settingsModal.className = 'settings-modal';
  settingsModal.innerHTML = `
    <div class="settings-content">
      <h3>Audio / Video Settings</h3>
      <label>Camera</label>
      <select id="videoSelect"></select>
      <label>Microphone</label>
      <select id="audioSelect"></select>
      <div class="settings-row">
        <button id="closeSettingsBtn" class="btn">Cancel</button>
        <button id="applySettingsBtn" class="btn primary">Apply</button>
      </div>
    </div>
  `;
  document.body.appendChild(settingsModal);

  videoSelect = $('videoSelect');
  audioSelect = $('audioSelect');
  applyBtn = $('applySettingsBtn');
  closeBtn = $('closeSettingsBtn');

  closeBtn.onclick = () => (settingsModal.style.display = 'none');
  applyBtn.onclick = applySettings;
}

async function applySettings() {
  const videoId = videoSelect.value;
  const audioId = audioSelect.value;
  currentVideoIndex = videoDevices.findIndex(d => d.deviceId === videoId);
  currentAudioIndex = audioDevices.findIndex(d => d.deviceId === audioId);

  const constraints = {
    video: videoId ? { deviceId: { exact: videoId }} : true,
    audio: audioId ? { deviceId: { exact: audioId }} : true
  };

  await ensureLocalStream(constraints);
  settingsModal.style.display = 'none';
}

// ---------- LOCK BUTTON ----------
function renderUserList(users, hostId, isHost, locked) {
  ensureUserListPanel();

  userListEl.innerHTML = '';
  users.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u.id === hostId ? `${u.name} 👑` : u.name;

    if (u.id !== hostId && isHost) {
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = 'Call';
      btn.onclick = () => callUser(u.id);
      li.appendChild(btn);
    }

    userListEl.appendChild(li);
  });

  lockBtn.disabled = !isHost;
  lockBtn.textContent = locked ? "Unlock Room" : "Lock Room";
  lockBtn.onclick = () => socket.emit('toggle-lock');
}

function ensureUserListPanel() {
  if (userListEl) return;
  const chatPanel = document.querySelector('.chat-panel');
  const wrapper = document.createElement('div');
  wrapper.className = 'user-list-block';
  wrapper.innerHTML = `<h3>Users</h3><ul id="userList"></ul><button id="lockBtn" class="btn">Lock Room</button>`;
  chatPanel.parentNode.insertBefore(wrapper, chatPanel);
  userListEl = document.getElementById('userList');
  lockBtn = document.getElementById('lockBtn');
}

// ---------- CHAT ----------
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', e => e.key === 'Enter' && sendChat());

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  const ts = Date.now();
  appendChat('You', text, ts);
  socket.emit('chat-message', { room: currentRoom, name: userName, text, ts });
  chatInput.value = '';
}

function appendChat(name, text, ts) {
  const el = document.createElement('div');
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<strong>${name}</strong> <small>${time}</small>: ${text}`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------- STREAM ----------
if (startStreamBtn) {
  startStreamBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert("Join room first");
    if (!localStream) await ensureLocalStream();
    startStreamBtn.disabled = true;
    startStreamBtn.textContent = "Streaming";
    hangupBtn.disabled = false;
    for (const userId of peerMap.keys()) {
      createPeerForUser(userId);
    }
  });
}

if (hangupBtn) {
  hangupBtn.addEventListener('click', stopEverything);
}

function stopEverything() {
  for (const pc of peerMap.values()) {
    pc.close();
  }
  peerMap.clear();

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  if (localVideo) localVideo.srcObject = null;
  startStreamBtn.disabled = false;
  startStreamBtn.textContent = "Start Stream";
  hangupBtn.disabled = true;
  isScreenSharing = false;
}

// ---------- INCOMING CALL UI ----------
function showIncomingCall(from, fromName) {
  const d = document.createElement('div');
  d.className = 'incoming-call-popup';
  d.innerHTML = `
    <div class="popup-inner">
      <p>📞 Incoming Call from <b>${fromName}</b></p>
      <button class="btn primary">Accept</button>
      <button class="btn">Reject</button>
    </div>
  `;
  document.body.appendChild(d);

  const [acceptBtn, rejectBtn] = d.querySelectorAll('button');
  acceptBtn.onclick = () => {
    sendCallResponse(from, true);
    createPeerForUser(from);
    d.remove();
  };
  rejectBtn.onclick = () => {
    sendCallResponse(from, false);
    d.remove();
  };
}

// ---------- STRIP ----------
function ensureCallStrip() {
  let strip = document.getElementById('callStrip');
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'callStrip';
    strip.className = 'call-strip';
    document.body.appendChild(strip);
  }
  return strip;
}
