// HOST - STREAM + CALL SEPARATE + DEVICE SETTINGS
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// Device info
let videoDevices = [];
let audioDevices = [];
let currentVideoIndex = 0;
let currentAudioIndex = 0;

// Simple ICE (server-side ICE/turn from config/ice.js is only for viewer side originally)
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Elements
const getEl = (id) => document.getElementById(id);
const joinBtn        = getEl('joinBtn');
const leaveBtn       = getEl('leaveBtn');
const roomInput      = getEl('roomInput');
const nameInput      = getEl('nameInput');
const startCallBtn   = getEl('startCallBtn');
const startStreamBtn = getEl('startStreamBtn');
const hangupBtn      = getEl('hangupBtn');
const shareScreenBtn = getEl('shareScreenBtn');
const toggleCamBtn   = getEl('toggleCamBtn');
const toggleMicBtn   = getEl('toggleMicBtn');
const changeCamBtn   = getEl('changeCamBtn');
const settingsBtn    = getEl('settingsBtn');

const localVideo     = getEl('localVideo');
const streamLinkInput= getEl('streamLinkInput');
const openStreamBtn  = getEl('openStreamBtn');
const signalStatusEl = getEl('signalStatus');
const roomInfo       = getEl('roomInfo');

// Chat
const chatLog        = getEl('chatLog');
const chatInput      = getEl('chatInput');
const sendBtn        = getEl('sendBtn');
const emojiStrip     = getEl('emojiStrip');
const fileInput      = getEl('fileInput');
const sendFileBtn    = getEl('sendFileBtn');
const fileNameLabel  = getEl('fileNameLabel');

// Settings modal
let settingsModal = null;
let videoSelect   = null;
let audioSelect   = null;
let applySettingsBtn = null;
let closeSettingsBtn = null;

// ---------- STATUS ----------
socket.on('connect', () => {
  if (signalStatusEl) {
    signalStatusEl.textContent = 'Connected';
    signalStatusEl.classList.add('status-connected');
    signalStatusEl.classList.remove('status-disconnected');
  }
});
socket.on('disconnect', () => {
  if (signalStatusEl) {
    signalStatusEl.textContent = 'Disconnected';
    signalStatusEl.classList.add('status-disconnected');
    signalStatusEl.classList.remove('status-connected');
  }
});

// ---------- JOIN ----------
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput.value.trim();
    if (!room) return alert("Enter Room Name");
    currentRoom = room;
    userName = (nameInput && nameInput.value.trim()) || 'Host';

    socket.connect();
    socket.emit('join-room', { room, name: userName });
    joinBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = false;

    if (roomInfo) roomInfo.textContent = `Room: ${room}`;

    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.searchParams.set('room', room);
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    stopEverything();
    socket.disconnect();
    window.location.reload();
  });
}

// ---------- DEVICE HELPERS ----------
async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter((d) => d.kind === 'videoinput');
    audioDevices = devices.filter((d) => d.kind === 'audioinput');

    if (videoDevices.length && currentVideoIndex >= videoDevices.length) {
      currentVideoIndex = 0;
    }
    if (audioDevices.length && currentAudioIndex >= audioDevices.length) {
      currentAudioIndex = 0;
    }
  } catch (err) {
    console.error('enumerateDevices error:', err);
  }
}

async function setLocalStream(constraintsOverride) {
  const constraints = constraintsOverride || {
    video: true,
    audio: true
  };

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  localStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
  }

  // If we're streaming, update the outgoing tracks
  if (pc && pc.getSenders) {
    const videoTrack = localStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks()[0];
    pc.getSenders().forEach((sender) => {
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

// ---------- START CALL (LOCAL PREVIEW ONLY) ----------
if (startCallBtn) {
  startCallBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert("Join Room First");

    if (!localStream) {
      try {
        await refreshDevices();
        await setLocalStream(); // uses default cam+mic
        startCallBtn.textContent = 'Stop Call Cam';
      } catch (err) {
        return alert("Camera Error: " + err.message);
      }
    } else {
      // turn off preview
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      if (localVideo) localVideo.srcObject = null;
      startCallBtn.textContent = 'Start Call';
    }
  });
}

// ---------- START STREAM (SEND TO VIEWERS) ----------
if (startStreamBtn) {
  startStreamBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert("Join Room First");

    try {
      if (!localStream) {
        await refreshDevices();
        await setLocalStream();
      }
    } catch (err) {
      return alert("Camera Error: " + err.message);
    }

    startStreamBtn.disabled = true;
    startStreamBtn.textContent = "Streaming Active";
    if (hangupBtn) hangupBtn.disabled = false;

    restartConnection();
  });
}

// ---------- HANG UP (STOP STREAM + CAM) ----------
if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    stopEverything();
  });
}

function stopEverything() {
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
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';

  if (startStreamBtn) {
    startStreamBtn.disabled = false;
    startStreamBtn.textContent = 'Start Stream';
  }
  if (hangupBtn) hangupBtn.disabled = true;

  if (startCallBtn) {
    startCallBtn.textContent = 'Start Call';
  }
}

// ---------- WEBRTC STREAM SETUP ----------
async function restartConnection() {
  if (!localStream) return;

  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  const stream = isScreenSharing && screenStream ? screenStream : localStream;
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  } catch (err) {
    console.error('Offer error', err);
  }
}

socket.on('user-joined', () => {
  if (localStream) {
    restartConnection();
  }
});

socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('addIceCandidate error', err);
    }
  }
});

// ---------- SCREEN SHARE ----------
if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!localStream) return alert('Start camera first!');
    if (!pc) await restartConnection();

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
        if (localVideo) localVideo.srcObject = screenStream;
        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';

        screenTrack.onended = () => stopScreenShare();
      } catch (err) {
        console.error('Screen share error', err);
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
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && camTrack) sender.replaceTrack(camTrack);
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// ---------- CAMERA / MIC TOGGLES ----------
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const enabled = localStream.getVideoTracks().some((t) => t.enabled);
    localStream.getVideoTracks().forEach((t) => (t.enabled = !enabled));
    toggleCamBtn.textContent = enabled ? 'Camera On' : 'Camera Off';
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const enabled = localStream.getAudioTracks().some((t) => t.enabled);
    localStream.getAudioTracks().forEach((t) => (t.enabled = !enabled));
    toggleMicBtn.textContent = enabled ? 'Unmute' : 'Mute';
  });
}

// ---------- CHANGE CAM (CYCLE) ----------
if (changeCamBtn) {
  changeCamBtn.addEventListener('click', async () => {
    try {
      await refreshDevices();
      if (!videoDevices.length) return alert('No extra cameras found');

      currentVideoIndex = (currentVideoIndex + 1) % videoDevices.length;
      const videoDeviceId = videoDevices[currentVideoIndex].deviceId;
      const audioDeviceId = audioDevices.length
        ? audioDevices[currentAudioIndex].deviceId
        : undefined;

      const constraints = {
        video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true
      };

      await setLocalStream(constraints);
    } catch (err) {
      console.error('Change cam error', err);
    }
  });
}

// ---------- SETTINGS MODAL (AUDIO/VIDEO PICKER) ----------
function createSettingsModal() {
  settingsModal = document.createElement('div');
  settingsModal.id = 'settingsModal';
  Object.assign(settingsModal.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,0.6)',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '999'
  });

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

  videoSelect       = document.getElementById('videoSelect');
  audioSelect       = document.getElementById('audioSelect');
  applySettingsBtn  = document.getElementById('applySettingsBtn');
  closeSettingsBtn  = document.getElementById('closeSettingsBtn');

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.style.display = 'none';
  });

  applySettingsBtn.addEventListener('click', async () => {
    const videoId = videoSelect.value || undefined;
    const audioId = audioSelect.value || undefined;

    const constraints = {
      video: videoId ? { deviceId: { exact: videoId } } : true,
      audio: audioId ? { deviceId: { exact: audioId } } : true
    };

    try {
      await setLocalStream(constraints);
    } catch (err) {
      console.error('Apply settings error', err);
    }

    settingsModal.style.display = 'none';
  });
}

async function openSettings() {
  // make sure we have permission at least once so labels are visible
  try {
    if (!localStream) {
      await setLocalStream();
    }
  } catch (err) {
    console.error('Error opening settings, getUserMedia failed', err);
  }

  await refreshDevices();

  if (!settingsModal) createSettingsModal();

  // Populate selects
  videoSelect.innerHTML = '';
  audioSelect.innerHTML = '';

  videoDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    if (i === currentVideoIndex) opt.selected = true;
    videoSelect.appendChild(opt);
  });

  audioDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Mic ${i + 1}`;
    if (i === currentAudioIndex) opt.selected = true;
    audioSelect.appendChild(opt);
  });

  settingsModal.style.display = 'flex';
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    openSettings().catch(console.error);
  });
}

// ---------- OPEN VIEWER ----------
if (openStreamBtn) {
  openStreamBtn.addEventListener('click', () => {
    if (!streamLinkInput || !streamLinkInput.value) return;
    window.open(streamLinkInput.value, '_blank');
  });
}

// ---------- CHAT ----------
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));

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

function sendChat() {
  if (!chatInput || !currentRoom) return;
  const text = chatInput.value.trim();
  if (!text) return;
  const ts = Date.now();
  socket.emit('chat-message', { room: currentRoom, name: userName, text, ts });
  appendChat('You', text, ts);
  chatInput.value = '';
}

function appendChat(name, text, ts) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const nameHtml = name === 'You'
    ? `<span style="color:#4af3a3">${name}</span>`
    : `<strong>${name}</strong>`;
  line.innerHTML = `${nameHtml} <small>${timeString(ts)}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function timeString(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------- FILES ----------
if (fileInput && sendFileBtn) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) {
      if (fileNameLabel) fileNameLabel.textContent = fileInput.files[0].name;
      sendFileBtn.disabled = false;
    }
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
      appendChat('You', `Sent file: ${file.name}`, Date.now());
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
  appendChat(name, `Sent file: ${link}`, Date.now());
});
