// HOST – STREAM + ROOM LOCK + DEVICE SETTINGS
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let mySocketId = null;
let isHost = false;

// ICE config (prefer config/ice.js if present)
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

// DOM helpers
const $ = id => document.getElementById(id);

// Core DOM
const nameInput       = $('nameInput');
const roomInput       = $('roomInput');
const joinBtn         = $('joinBtn');
const leaveBtn        = $('leaveBtn');
const localVideo      = $('localVideo');
const remoteVideo     = $('remoteVideo'); // not used yet, but kept for future multi-call
const startCallBtn    = $('startCallBtn');
const shareScreenBtn  = $('shareScreenBtn');
const hangupBtn       = $('hangupBtn');
const toggleCamBtn    = $('toggleCamBtn');
const toggleMicBtn    = $('toggleMicBtn');

const signalStatus    = $('signalStatus');
const roomInfo        = $('roomInfo');
const streamLinkInput = $('streamLinkInput');
const openStreamBtn   = $('openStreamBtn');

// Chat & files
const chatLog       = $('chatLog');
const chatInput     = $('chatInput');
const sendBtn       = $('sendBtn');
const emojiStrip    = $('emojiStrip');
const fileInput     = $('fileInput');
const sendFileBtn   = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');

// Extra UI we’ll create in JS
let lockBtn = null;
let lockStatusEl = null;
let userListEl = null;
let settingsBtn = null;

// Settings modal bits
let settingsModal = null;
let videoSelect = null;
let audioSelect = null;
let applySettingsBtn = null;
let closeSettingsBtn = null;

// Device cache
let videoDevices = [];
let audioDevices = [];

// ---------- Helpers ----------
function setSignal(connected) {
  if (!signalStatus) return;
  signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
  signalStatus.className   = connected
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
  const who = name === 'You'
    ? `<span style="color:#4af3a3">${name}</span>`
    : `<strong>${name}</strong>`;
  line.innerHTML = `${who} <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Start / ensure local cam+mic (preview only)
async function ensureLocalStream(constraintsOverride) {
  if (localStream && !constraintsOverride) return localStream;

  const constraints = constraintsOverride || { video: true, audio: true };

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }

  localStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
  }

  // Update senders if already streaming
  if (pc) {
    const videoTrack = localStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks()[0];
    pc.getSenders().forEach(sender => {
      if (sender.track && sender.track.kind === 'video' && videoTrack) {
        sender.replaceTrack(videoTrack);
      }
      if (sender.track && sender.track.kind === 'audio' && audioTrack) {
        sender.replaceTrack(audioTrack);
      }
    });
  }

  return localStream;
}

// ---------- WebRTC (broadcast host) ----------
function createHostPC() {
  if (pc) {
    try { pc.close(); } catch (e) {}
  }
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
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

  // Make sure we have a local preview stream
  await ensureLocalStream();

  const stream = isScreenSharing && screenStream ? screenStream : localStream;
  if (!stream) return;

  createHostPC();

  // Attach tracks
  pc.getSenders().forEach(s => pc.removeTrack(s));
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

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
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (localVideo) localVideo.srcObject = null;

  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';

  if (startCallBtn) {
    startCallBtn.disabled = false;
    startCallBtn.textContent = 'Start Call';
  }
  if (hangupBtn) hangupBtn.disabled = true;
}

// Re-offer whenever a viewer joins
socket.on('user-joined', () => {
  if (localStream) {
    startBroadcast().catch(console.error);
  }
});

// Viewer answer
socket.on('webrtc-answer', async ({ sdp }) => {
  if (!pc || !sdp) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (e) {
    console.error('Host setRemoteDescription error:', e);
  }
});

// ICE from viewer
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Host ICE add error:', e);
  }
});

// ---------- Join / leave ----------
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput && roomInput.value.trim();
    if (!room) return alert('Enter room');

    currentRoom = room;
    userName = (nameInput && nameInput.value.trim()) || 'Host';

    socket.connect();
    socket.emit('join-room', { room: currentRoom, name: userName });

    joinBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = false;
    if (roomInfo) roomInfo.textContent = `Room: ${room}`;

    // Build viewer link
    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.search = `?room=${encodeURIComponent(room)}`;
    if (streamLinkInput) streamLinkInput.value = url.toString();

    // Start camera preview automatically (so stream is separate)
    ensureLocalStream().catch(console.error);
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    stopBroadcast();
    socket.disconnect();
    window.location.reload();
  });
}

// Start / stop stream
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

// ---------- Screen share ----------
if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert('Join a room first');
    await ensureLocalStream();
    if (!pc) await startBroadcast();

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });
        const track = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find(
          s => s.track && s.track.kind === 'video'
        );
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
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (localStream && pc) {
    const camTrack = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(
      s => s.track && s.track.kind === 'video'
    );
    if (sender && camTrack) sender.replaceTrack(camTrack);
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// ---------- Cam / mic toggles ----------
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const enabled = localStream.getVideoTracks().some(t => t.enabled);
    localStream.getVideoTracks().forEach(t => (t.enabled = !enabled));
    toggleCamBtn.textContent = enabled ? 'Camera On' : 'Camera Off';
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const enabled = localStream.getAudioTracks().some(t => t.enabled);
    localStream.getAudioTracks().forEach(t => (t.enabled = !enabled));
    toggleMicBtn.textContent = enabled ? 'Unmute' : 'Mute';
  });
}

// ---------- Open viewer ----------
if (openStreamBtn) {
  openStreamBtn.addEventListener('click', () => {
    if (!streamLinkInput || !streamLinkInput.value) return;
    window.open(streamLinkInput.value, '_blank');
  });
}

// ---------- Chat ----------
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

function sendChat() {
  if (!currentRoom || !chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { room: currentRoom, name: userName, text });
  appendChat('You', text);
  chatInput.value = '';
}

if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) {
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
  });
}
if (emojiStrip) {
  emojiStrip.addEventListener('click', e => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

// ---------- Files ----------
if (fileInput && sendFileBtn) {
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (fileNameLabel) {
      fileNameLabel.textContent = file ? file.name : 'No file';
    }
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

// ---------- Room lock + user list ----------
socket.on('room-state', ({ hostId, locked, users }) => {
  isHost = mySocketId && (mySocketId === hostId);

  if (lockBtn) {
    lockBtn.disabled = !isHost;
    lockBtn.textContent = locked ? 'Unlock Room' : 'Lock Room';
  }
  if (lockStatusEl) {
    lockStatusEl.textContent = locked ? 'Locked' : 'Unlocked';
  }

  if (userListEl) {
    userListEl.innerHTML = '';
    (users || []).forEach(u => {
      const li = document.createElement('li');
      li.textContent = (u.name || 'Anon') + (u.id === hostId ? ' 👑' : '');
      userListEl.appendChild(li);
    });
  }
});

socket.on('room-locked', () => {
  appendChat('System', 'Room is locked by the host.');
});

socket.on('user-left', ({ id }) => {
  appendChat('System', 'A viewer left.');
});

// ---------- Socket connection status ----------
socket.on('connect', () => {
  mySocketId = socket.id;
  setSignal(true);
});

socket.on('disconnect', () => {
  setSignal(false);
});

// ---------- Extra UI: lock button, user list, settings modal ----------
function setupExtras() {
  // Lock button + status in connection panel
  const connectionPanel = document.querySelector('.connection-panel');
  if (connectionPanel) {
    lockBtn = document.createElement('button');
    lockBtn.id = 'lockBtn';
    lockBtn.className = 'btn';
    lockBtn.textContent = 'Lock Room';
    lockBtn.disabled = true;
    connectionPanel.appendChild(lockBtn);

    lockStatusEl = document.createElement('span');
    lockStatusEl.id = 'lockStatus';
    lockStatusEl.style.marginLeft = '8px';
    lockStatusEl.style.fontSize = '0.8rem';
    lockStatusEl.style.opacity = '0.8';
    lockStatusEl.textContent = 'Unlocked';
    connectionPanel.appendChild(lockStatusEl);

    lockBtn.addEventListener('click', () => {
      if (!currentRoom || !isHost) return;
      socket.emit('toggle-lock', { room: currentRoom });
    });
  }

  // User list above chat log
  if (chatLog && !document.getElementById('userList')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'user-list-wrapper';
    wrapper.style.marginBottom = '6px';

    const title = document.createElement('div');
    title.textContent = 'In Room';
    title.style.fontSize = '0.8rem';
    title.style.opacity = '0.8';
    title.style.marginBottom = '2px';

    userListEl = document.createElement('ul');
    userListEl.id = 'userList';
    userListEl.style.listStyle = 'none';
    userListEl.style.margin = '0';
    userListEl.style.padding = '0';
    userListEl.style.fontSize = '0.8rem';

    wrapper.appendChild(title);
    wrapper.appendChild(userListEl);

    chatLog.parentNode.insertBefore(wrapper, chatLog);
  }

  // Settings button in call controls
  const controls = document.querySelector('.call-controls');
  if (controls) {
    settingsBtn = document.createElement('button');
    settingsBtn.id = 'settingsBtn';
    settingsBtn.className = 'btn';
    settingsBtn.textContent = 'Settings';
    controls.appendChild(settingsBtn);
  }

  setupSettingsModal();
}

function setupSettingsModal() {
  settingsModal = document.createElement('div');
  settingsModal.id = 'settingsModal';
  settingsModal.style.position = 'fixed';
  settingsModal.style.inset = '0';
  settingsModal.style.background = 'rgba(0,0,0,0.6)';
  settingsModal.style.display = 'none';
  settingsModal.style.alignItems = 'center';
  settingsModal.style.justifyContent = 'center';
  settingsModal.style.zIndex = '999';

  settingsModal.innerHTML = `
    <div style="background:#151a2b; padding:16px; border-radius:12px; min-width:260px; max-width:320px;">
      <h3 style="margin-top:0; margin-bottom:10px; font-size:1rem;">Audio / Video Settings</h3>
      <label style="display:block; font-size:0.8rem; margin-bottom:4px;">Camera</label>
      <select id="videoSelect" style="width:100%; margin-bottom:10px;"></select>
      <label style="display:block; font-size:0.8rem; margin-bottom:4px;">Microphone</label>
      <select id="audioSelect" style="width:100%; margin-bottom:10px;"></select>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button id="closeSettingsBtn" class="btn">Cancel</button>
        <button id="applySettingsBtn" class="btn primary">Apply</button>
      </div>
    </div>
  `;

  document.body.appendChild(settingsModal);

  videoSelect = document.getElementById('videoSelect');
  audioSelect = document.getElementById('audioSelect');
  applySettingsBtn = document.getElementById('applySettingsBtn');
  closeSettingsBtn = document.getElementById('closeSettingsBtn');

  if (settingsBtn) {
    settingsBtn.addEventListener('click', openSettings);
  }

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      settingsModal.style.display = 'none';
    }
  });

  applySettingsBtn.addEventListener('click', () => {
    applySettings().catch(console.error);
  });
}

async function loadDeviceList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(d => d.kind === 'videoinput');
    audioDevices = devices.filter(d => d.kind === 'audioinput');

    if (videoSelect) {
      videoSelect.innerHTML = '';
      videoDevices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${i + 1}`;
        videoSelect.appendChild(opt);
      });
    }

    if (audioSelect) {
      audioSelect.innerHTML = '';
      audioDevices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Mic ${i + 1}`;
        audioSelect.appendChild(opt);
      });
    }
  } catch (e) {
    console.error('enumerateDevices error:', e);
  }
}

async function openSettings() {
  // Make sure we’ve asked for media at least once so labels appear
  await ensureLocalStream().catch(console.error);
  await loadDeviceList();
  settingsModal.style.display = 'flex';
}

async function applySettings() {
  const videoId = videoSelect && videoSelect.value;
  const audioId = audioSelect && audioSelect.value;

  const constraints = {
    video: videoId ? { deviceId: { exact: videoId } } : true,
    audio: audioId ? { deviceId: { exact: audioId } } : true
  };

  await ensureLocalStream(constraints);
  settingsModal.style.display = 'none';
}

// Initialize extra UI on load
setupExtras();
