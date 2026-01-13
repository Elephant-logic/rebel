// REBEL MESSENGER - FINAL PRODUCTION VERSION
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let activeChatMode = 'public';

// GLOBAL DATA
let latestUserList = [];
let currentOwnerId = null;

// MEDIA
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false;

// PEER CONNECTIONS
const viewerPeers = {};   // streaming to viewers
const callPeers = {};     // 1:1 calls

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = id => document.getElementById(id);

// --- TABS LOGIC ---
const tabs = {
  stream: $('tabStreamChat'),
  room: $('tabRoomChat'),
  files: $('tabFiles'),
  users: $('tabUsers')
};
const contents = {
  stream: $('contentStreamChat'),
  room: $('contentRoomChat'),
  files: $('contentFiles'),
  users: $('contentUsers')
};

function switchTab(name) {
  if (!tabs[name]) return;
  Object.values(tabs).forEach(t => t.classList.remove('active'));
  Object.values(contents).forEach(c => c.classList.remove('active'));
  tabs[name].classList.add('active');
  contents[name].classList.add('active');
  tabs[name].classList.remove('has-new');
}

if (tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if (tabs.room) tabs.room.onclick = () => switchTab('room');
if (tabs.files) tabs.files.onclick = () => switchTab('files');
if (tabs.users) tabs.users.onclick = () => switchTab('users');

// --- SETTINGS ---
const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const videoSource = $('videoSource');

if ($('settingsBtn')) {
  $('settingsBtn').addEventListener('click', () => {
    const isHidden = !settingsPanel.style.display || settingsPanel.style.display === 'none';
    settingsPanel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) getDevices();
  });
}
if ($('closeSettingsBtn')) {
  $('closeSettingsBtn').addEventListener('click', () => {
    settingsPanel.style.display = 'none';
  });
}

async function getDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioSource.innerHTML = '';
    videoSource.innerHTML = '';
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
      if (d.kind === 'audioinput') audioSource.appendChild(opt);
      if (d.kind === 'videoinput') videoSource.appendChild(opt);
    });
    if (localStream) {
      const at = localStream.getAudioTracks()[0];
      const vt = localStream.getVideoTracks()[0];
      if (at && at.getSettings().deviceId) audioSource.value = at.getSettings().deviceId;
      if (vt && vt.getSettings().deviceId) videoSource.value = vt.getSettings().deviceId;
    }
  } catch (e) {
    console.error(e);
  }
}

audioSource && (audioSource.onchange = startLocalMedia);
videoSource && (videoSource.onchange = startLocalMedia);

// --- MEDIA FUNCTIONS ---
async function startLocalMedia() {
  if (isScreenSharing) return;
  if (localStream) localStream.getTracks().forEach(t => t.stop());

  const constraints = {
    audio: audioSource && audioSource.value ? { deviceId: { exact: audioSource.value } } : true,
    video: videoSource && videoSource.value ? { deviceId: { exact: videoSource.value } } : true
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    $('localVideo').srcObject = localStream;
    $('localVideo').muted = true;

    const tracks = localStream.getTracks();
    const updatePC = pc => {
      if (!pc) return;
      const senders = pc.getSenders();
      tracks.forEach(t => {
        const sender = senders.find(s => s.track && s.track.kind === t.kind);
        if (sender) sender.replaceTrack(t);
      });
    };
    Object.values(viewerPeers).forEach(updatePC);
    Object.values(callPeers).forEach(p => updatePC(p.pc));

    $('hangupBtn').disabled = false;
    updateMediaButtons();
  } catch (e) {
    console.error(e);
    alert('Camera Error – check permissions.');
  }
}

function updateMediaButtons() {
  if (!localStream) return;
  const vTrack = localStream.getVideoTracks()[0];
  const aTrack = localStream.getAudioTracks()[0];

  const camBtn = $('toggleCamBtn');
  const micBtn = $('toggleMicBtn');
  if (camBtn) {
    const on = vTrack && vTrack.enabled;
    camBtn.textContent = on ? 'Camera On' : 'Camera Off';
    camBtn.classList.toggle('danger', !on);
  }
  if (micBtn) {
    const on = aTrack && aTrack.enabled;
    micBtn.textContent = on ? 'Mute' : 'Unmute';
    micBtn.classList.toggle('danger', !on);
  }
}

// toggle mic
if ($('toggleMicBtn')) {
  $('toggleMicBtn').addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    updateMediaButtons();
  });
}

// toggle cam
if ($('toggleCamBtn')) {
  $('toggleCamBtn').addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    updateMediaButtons();
  });
}

// screen share
if ($('shareScreenBtn')) {
  $('shareScreenBtn').addEventListener('click', async () => {
    if (isScreenSharing) {
      stopScreenShare();
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      isScreenSharing = true;
      $('shareScreenBtn').textContent = 'Stop Screen';
      $('shareScreenBtn').classList.add('danger');

      $('localVideo').srcObject = screenStream;
      const screenTrack = screenStream.getVideoTracks()[0];

      const updatePC = pc => {
        if (!pc) return;
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      };
      Object.values(viewerPeers).forEach(updatePC);
      Object.values(callPeers).forEach(p => updatePC(p.pc));

      screenTrack.onended = stopScreenShare;
    } catch (e) {
      console.error(e);
    }
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  isScreenSharing = false;
  $('shareScreenBtn').textContent = 'Share Screen';
  $('shareScreenBtn').classList.remove('danger');

  $('localVideo').srcObject = localStream;
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    const updatePC = pc => {
      if (!pc) return;
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(camTrack);
    };
    Object.values(viewerPeers).forEach(updatePC);
    Object.values(callPeers).forEach(p => updatePC(p.pc));
  }
}

// --- STREAMING (HOST → VIEWERS) ---
if ($('startStreamBtn')) {
  $('startStreamBtn').addEventListener('click', async () => {
    if (!currentRoom || !iAmHost) return alert('Host only');

    if (isStreaming) {
      isStreaming = false;
      $('startStreamBtn').textContent = 'Start Stream';
      $('startStreamBtn').classList.remove('danger');
      Object.values(viewerPeers).forEach(pc => pc.close());
      Object.keys(viewerPeers).forEach(k => delete viewerPeers[k]);
      return;
    }

    if (!localStream) await startLocalMedia();
    isStreaming = true;
    $('startStreamBtn').textContent = 'Stop Stream';
    $('startStreamBtn').classList.add('danger');

    latestUserList.forEach(u => {
      if (u.id !== myId) connectViewer(u.id);
    });
  });
}

socket.on('user-joined', ({ id, name }) => {
  appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
  if (iAmHost && isStreaming) connectViewer(id);
});

async function connectViewer(targetId) {
  if (viewerPeers[targetId]) return;
  const pc = new RTCPeerConnection(iceConfig);
  viewerPeers[targetId] = pc;

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      pc.close();
      delete viewerPeers[targetId];
    }
  };

  const stream = isScreenSharing ? screenStream : localStream;
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => {
  const pc = viewerPeers[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
  const pc = viewerPeers[from];
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('user-left', ({ id }) => {
  if (viewerPeers[id]) {
    viewerPeers[id].close();
    delete viewerPeers[id];
  }
  endPeerCall(id, true);
});

// --- CALLING (USER <-> USER) ---
socket.on('ring-alert', async ({ from, fromId }) => {
  if (confirm(`📞 Incoming call from ${from}. Accept?`)) {
    await callPeer(fromId);
  }
});

async function callPeer(targetId) {
  if (!localStream) await startLocalMedia();
  const pc = new RTCPeerConnection(iceConfig);
  callPeers[targetId] = { pc, name: 'Peer' };

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate });
  };
  pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]);

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call-offer', { targetId, offer });
  renderUserList();
}

socket.on('incoming-call', async ({ from, name, offer }) => {
  if (!localStream) await startLocalMedia();
  const pc = new RTCPeerConnection(iceConfig);
  callPeers[from] = { pc, name };

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('call-ice', { targetId: from, candidate: e.candidate });
  };
  pc.ontrack = e => addRemoteVideo(from, e.streams[0]);

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call-answer', { targetId: from, answer });
  renderUserList();
});

socket.on('call-answer', async ({ from, answer }) => {
  const entry = callPeers[from];
  if (entry) {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('call-ice', ({ from, candidate }) => {
  const entry = callPeers[from];
  if (entry) entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('call-end', ({ from }) => {
  endPeerCall(from, true);
});

function endPeerCall(id, isIncomingSignal) {
  const entry = callPeers[id];
  if (entry) {
    try { entry.pc.close(); } catch (e) {}
  }
  delete callPeers[id];
  removeRemoteVideo(id);
  if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
  renderUserList();
}

// --- SOCKET CORE ---
socket.on('connect', () => {
  const sig = $('signalStatus');
  if (sig) {
    sig.className = 'status-dot status-connected';
    sig.textContent = 'Connected';
  }
  myId = socket.id;
});

socket.on('disconnect', () => {
  const sig = $('signalStatus');
  if (sig) {
    sig.className = 'status-dot status-disconnected';
    sig.textContent = 'Disconnected';
  }
});

// IMPORTANT: handle kick cleanly
socket.on('kicked', () => {
  alert('You have been removed from the room by the host.');
  window.location.reload();
});

if ($('joinBtn')) {
  $('joinBtn').addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    if (!room) return;
    currentRoom = room;
    userName = $('nameInput').value.trim() || 'Host';
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    $('joinBtn').disabled = true;
    $('leaveBtn').disabled = false;
    updateLink(room);
    startLocalMedia();
  });
}

// LEAVE BUTTON LOGIC – just hard reset
if ($('leaveBtn')) {
  $('leaveBtn').addEventListener('click', () => {
    window.location.reload();
  });
}

function updateLink(roomSlug) {
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace('index.html', '') + 'view.html';
  url.search = `?room=${encodeURIComponent(roomSlug)}`;
  const box = $('streamLinkInput');
  if (box) box.value = url.toString();
}

if ($('updateSlugBtn')) {
  $('updateSlugBtn').addEventListener('click', () => {
    const slug = $('slugInput').value.trim();
    if (slug) updateLink(slug);
  });
}

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
  latestUserList = users || [];
  currentOwnerId = ownerId || null;

  const lockBtn = $('lockRoomBtn');
  if (lockBtn) {
    lockBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
    lockBtn.onclick = () => {
      if (iAmHost) socket.emit('lock-room', !locked);
    };
  }

  const titleInput = $('streamTitleInput');
  if (titleInput && streamTitle) {
    titleInput.value = streamTitle;
  }

  renderUserList();
});

socket.on('role', ({ isHost, streamTitle }) => {
  iAmHost = !!isHost;
  const localContainer = $('localContainer');
  if (localContainer) {
    const h2 = localContainer.querySelector('h2');
    if (h2) h2.textContent = isHost ? 'You (Host) 👑' : 'You';
  }
  const hc = $('hostControls');
  if (hc) hc.style.display = isHost ? 'block' : 'none';

  const titleInput = $('streamTitleInput');
  if (titleInput && streamTitle) {
    titleInput.value = streamTitle;
  }

  renderUserList();
});

// --- CHAT LOGIC ---
function appendChat(log, name, text, ts) {
  if (!log) return;
  const d = document.createElement('div');
  d.className = 'chat-line';
  d.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text}`;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

// PUBLIC
socket.on('public-chat', d => {
  appendChat($('chatLogPublic'), d.name, d.text, d.ts);
  if (!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new');
});
if ($('btnSendPublic')) {
  $('btnSendPublic').addEventListener('click', () => {
    const inp = $('inputPublic');
    const text = inp.value.trim();
    if (!text) return;
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
  });
}

// PRIVATE
socket.on('private-chat', d => {
  appendChat($('chatLogPrivate'), d.name, d.text, d.ts);
  if (!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new');
});
if ($('btnSendPrivate')) {
  $('btnSendPrivate').addEventListener('click', () => {
    const inp = $('inputPrivate');
    const text = inp.value.trim();
    if (!text) return;
    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
  });
}

// EMOJI
const emojiStripPublic = $('emojiStripPublic');
const emojiStripPrivate = $('emojiStripPrivate');

if (emojiStripPublic) {
  emojiStripPublic.addEventListener('click', e => {
    if (e.target.classList.contains('emoji')) {
      const inp = $('inputPublic');
      inp.value += e.target.textContent;
      inp.focus();
    }
  });
}
if (emojiStripPrivate) {
  emojiStripPrivate.addEventListener('click', e => {
    if (e.target.classList.contains('emoji')) {
      const inp = $('inputPrivate');
      inp.value += e.target.textContent;
      inp.focus();
    }
  });
}

// --- FILE LOGIC ---
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileLog = $('fileLog');
const fileNameLabel = $('fileNameLabel');
const fileTarget = $('fileTarget');

if (fileInput && sendFileBtn) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      if (fileNameLabel) fileNameLabel.textContent = file.name;
      sendFileBtn.disabled = false;
    } else {
      if (fileNameLabel) fileNameLabel.textContent = 'No file selected';
      sendFileBtn.disabled = true;
    }
  });

  sendFileBtn.addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const targetId = (fileTarget && fileTarget.value !== 'all') ? fileTarget.value : null;

      socket.emit('file-share', {
        room: currentRoom,
        name: userName,
        fileName: file.name,
        fileData: reader.result,
        targetId
      });

      fileInput.value = '';
      if (fileNameLabel) fileNameLabel.textContent = 'No file selected';
      sendFileBtn.disabled = true;
    };
    reader.readAsDataURL(file);
  });
}

socket.on('file-share', ({ name, fileName, fileData }) => {
  if (!fileLog) return;
  const d = document.createElement('div');
  d.className = 'file-item';
  d.innerHTML = `
    <div><strong>${name}</strong> shared: ${fileName}</div>
    <a href="${fileData}" download="${fileName}" class="btn small primary">Download</a>
  `;
  fileLog.appendChild(d);
  if (!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});

// update targets dropdown when user list changes
function updateFileTargets() {
  if (!fileTarget) return;

  const prev = fileTarget.value;
  fileTarget.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'Everyone in room';
  fileTarget.appendChild(optAll);

  if (!latestUserList) return;

  latestUserList.forEach(u => {
    if (u.id === myId) return;
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name || u.id;
    fileTarget.appendChild(opt);
  });

  const hasPrev = Array.from(fileTarget.options).some(o => o.value === prev);
  if (hasPrev) fileTarget.value = prev;
}

// --- USERS LIST + REMOTE VIDEO ---
function renderUserList() {
  const list = $('userList');
  if (!list) return;
  list.innerHTML = '';
  if (!latestUserList) return;

  latestUserList.forEach(u => {
    if (u.id === myId) return;

    const div = document.createElement('div');
    div.className = 'user-item';

    const isCalling = !!callPeers[u.id];
    const actionBtn = isCalling
      ? `<button onclick="endPeerCall('${u.id}')" class="action-btn" style="border-color:var(--danger); color:var(--danger)">End Call</button>`
      : `<button onclick="ringUser('${u.id}')" class="action-btn">📞 Call</button>`;

    const kickBtn = iAmHost
      ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>`
      : '';

    div.innerHTML = `
      <span>${u.id === currentOwnerId ? '👑' : ''} ${u.name}</span>
      <div class="user-actions">
        ${actionBtn}
        ${kickBtn}
      </div>
    `;
    list.appendChild(div);
  });

  updateFileTargets();
}

function addRemoteVideo(id, stream) {
  let existing = document.getElementById(`vid-${id}`);
  if (existing) {
    const vid = existing.querySelector('video');
    if (vid && vid.srcObject !== stream) vid.srcObject = stream;
    return;
  }
  const d = document.createElement('div');
  d.className = 'video-container';
  d.id = `vid-${id}`;
  d.innerHTML = `<video autoplay playsinline></video>`;
  d.querySelector('video').srcObject = stream;
  $('videoGrid').appendChild(d);
}

function removeRemoteVideo(id) {
  const el = document.getElementById(`vid-${id}`);
  if (el) el.remove();
}

// global helpers for inline onclick
window.ringUser = id => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = id => socket.emit('kick-user', id);

if ($('openStreamBtn')) {
  $('openStreamBtn').addEventListener('click', () => {
    const url = $('streamLinkInput').value;
    if (url) window.open(url, '_blank');
  });
}
