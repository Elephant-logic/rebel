// HOST - RESTARTABLE VERSION WITH HOST CROWN, LOCK & SETTINGS
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// optional chosen devices
let selectedVideoDeviceId = null;
let selectedAudioDeviceId = null;

// GOOGLE STUN (or override with ICE_SERVERS in config/ice.js)
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

// Elements
const getEl = (id) => document.getElementById(id);

const nameInput       = getEl('nameInput');
const joinBtn         = getEl('joinBtn');
const leaveBtn        = getEl('leaveBtn');
const roomInput       = getEl('roomInput');
const roomInfoEl      = getEl('roomInfo');

const startCallBtn    = getEl('startCallBtn');
const startStreamBtn  = getEl('startStreamBtn');
const hangupBtn       = getEl('hangupBtn');
const localVideo      = getEl('localVideo');
const remoteVideo     = getEl('remoteVideo'); // not used yet, for future multi-call
const toggleCamBtn    = getEl('toggleCamBtn');
const toggleMicBtn    = getEl('toggleMicBtn');
const shareScreenBtn  = getEl('shareScreenBtn');
const settingsBtn     = getEl('settingsBtn');

const streamLinkInput = getEl('streamLinkInput');
const openStreamBtn   = getEl('openStreamBtn');
const signalStatusEl  = getEl('signalStatus');

// Chat & files
const chatLog       = getEl('chatLog');
const chatInput     = getEl('chatInput');
const sendBtn       = getEl('sendBtn');
const emojiStrip    = getEl('emojiStrip');
const fileInput     = getEl('fileInput');
const sendFileBtn   = getEl('sendFileBtn');
const fileNameLabel = getEl('fileNameLabel');

// Room UI
const userListEl    = getEl('userList');
const lockBtn       = getEl('lockBtn');

// ---------- Helpers ----------

function setSignal(connected) {
  if (!signalStatusEl) return;
  signalStatusEl.textContent = connected ? 'Connected' : 'Disconnected';
  signalStatusEl.classList.toggle('status-connected', connected);
  signalStatusEl.classList.toggle('status-disconnected', !connected);
}

function timeString(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = timeString(ts);
  const who = name === 'You'
    ? `<span style="color:#4af3a3">${name}</span>`
    : `<strong>${name}</strong>`;
  line.innerHTML = `${who} <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function getPreferredUserMedia() {
  const constraints = {
    video: selectedVideoDeviceId
      ? { deviceId: { exact: selectedVideoDeviceId } }
      : true,
    audio: selectedAudioDeviceId
      ? { deviceId: { exact: selectedAudioDeviceId } }
      : true
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

// ---------- Status events ----------

socket.on('connect', () => setSignal(true));
socket.on('disconnect', () => setSignal(false));

// ---------- JOIN / LEAVE ----------

if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput && roomInput.value.trim();
    if (!room) return alert('Enter Room Name');

    currentRoom = room;
    userName = (nameInput && nameInput.value.trim()) || 'Host';

    socket.connect();
    socket.emit('join-room', { room: currentRoom, name: userName });

    joinBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = false;
    if (roomInfoEl) roomInfoEl.textContent = `Room: ${room}`;

    // Build stream link to viewer
    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.searchParams.set('room', room);
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    // stop streaming + camera
    if (pc) { pc.close(); pc = null; }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
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

    socket.disconnect();
    currentRoom = null;

    if (joinBtn) joinBtn.disabled = false;
    if (leaveBtn) leaveBtn.disabled = true;
    if (roomInfoEl) roomInfoEl.textContent = 'No room';
    if (streamLinkInput) streamLinkInput.value = '';
    if (chatLog) chatLog.innerHTML = '';
    if (userListEl) userListEl.innerHTML = '';
  });
}

// ---------- CALL vs STREAM ----------

// Start Call = just turn camera on/off for you (no broadcast)
if (startCallBtn) {
  startCallBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert('Join Room First');

    if (!localStream) {
      try {
        localStream = await getPreferredUserMedia();
        if (localVideo) {
          localVideo.srcObject = localStream;
          localVideo.muted = true;
        }
      } catch (err) {
        return alert('Camera Error: ' + err.message);
      }
    } else {
      // Toggle camera completely off
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      if (localVideo) localVideo.srcObject = null;
    }
  });
}

// Stream = actually broadcast to viewers
if (startStreamBtn) {
  startStreamBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert('Join Room First');

    if (!localStream) {
      try {
        localStream = await getPreferredUserMedia();
        if (localVideo) {
          localVideo.srcObject = localStream;
          localVideo.muted = true;
        }
      } catch (err) {
        return alert('Camera Error: ' + err.message);
      }
    }

    startStreamBtn.disabled = true;
    startStreamBtn.textContent = 'Streaming Active';
    if (hangupBtn) hangupBtn.disabled = false;

    restartConnection();
  });
}

//  HANG UP
if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    if (pc) { pc.close(); pc = null; }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }
    if (localVideo) localVideo.srcObject = null;
    if (startStreamBtn) {
      startStreamBtn.disabled = false;
      startStreamBtn.textContent = 'Start Stream';
    }
    hangupBtn.disabled = true;
    isScreenSharing = false;
    if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
  });
}

// ---------- WebRTC: re-offer on viewer join ----------

socket.on('user-joined', () => {
  if (localStream || screenStream) {
    restartConnection();
  }
});

async function restartConnection() {
  if (!currentRoom) return;
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

  const stream = isScreenSharing ? screenStream : localStream;
  if (stream) {
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
  }

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  } catch (err) {
    console.error('Offer error', err);
  }
}

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

// ---------- Screen share ----------

if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!localStream) return alert('Start camera or stream first!');
    if (!pc) await restartConnection();

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender && screenTrack) sender.replaceTrack(screenTrack);
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
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (localStream && pc) {
    const camTrack = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && camTrack) sender.replaceTrack(camTrack);
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// ---------- Cam / Mic toggles ----------

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

// ---------- Chat (fixed so joiner replies work properly) ----------

socket.on('chat-message', ({ name, text, ts, senderId }) => {
  const label = senderId === socket.id ? 'You' : (name || 'Anon');
  appendChat(label, text, ts);
});

function sendChat() {
  if (!chatInput || !currentRoom) return;
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', {
    room: currentRoom,
    name: userName,
    text
  });
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

// ---------- File share (unchanged) ----------

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
  appendChat(name || 'Anon', `Sent file: ${link}`, Date.now());
});

// ---------- Room state: host 👑 + lock + user list ----------

socket.on('room-state', ({ room, hostId, locked, users }) => {
  if (!currentRoom || room !== currentRoom) return;

  if (lockBtn) {
    lockBtn.textContent = locked ? 'Unlock Room' : 'Lock Room';
  }

  if (!userListEl) return;
  userListEl.innerHTML = '';

  (users || []).forEach((u) => {
    const pill = document.createElement('div');
    let cls = 'user-pill';
    if (u.id === socket.id) cls += ' you';
    pill.className = cls;

    const labelParts = [];
    if (u.id === hostId) labelParts.push('👑');
    labelParts.push(u.name || 'Anon');

    const span = document.createElement('span');
    span.textContent = labelParts.join(' ');
    pill.appendChild(span);

    userListEl.appendChild(pill);
  });
});

if (lockBtn) {
  lockBtn.addEventListener('click', () => {
    if (!currentRoom) return;
    socket.emit('toggle-lock', { room: currentRoom });
  });
}

socket.on('room-locked', () => {
  alert('This room is locked by the host.');
});

// ---------- Simple A/V settings (prompt-based) ----------

async function chooseDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    alert('Device selection not supported in this browser');
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videos = devices.filter(d => d.kind === 'videoinput');
  const audios = devices.filter(d => d.kind === 'audioinput');

  // Camera
  let msg = 'Available cameras:\n';
  videos.forEach((d, i) => {
    msg += `${i}: ${d.label || 'Camera ' + (i + 1)}\n`;
  });
  msg += '\nEnter camera index (or leave blank):';
  const camChoice = prompt(msg);
  if (camChoice !== null && camChoice !== '' && !isNaN(camChoice)) {
    const idx = parseInt(camChoice, 10);
    if (videos[idx]) selectedVideoDeviceId = videos[idx].deviceId;
  }

  // Mic
  let msg2 = 'Available microphones:\n';
  audios.forEach((d, i) => {
    msg2 += `${i}: ${d.label || 'Mic ' + (i + 1)}\n`;
  });
  msg2 += '\nEnter mic index (or leave blank):';
  const micChoice = prompt(msg2);
  if (micChoice !== null && micChoice !== '' && !isNaN(micChoice)) {
    const idx2 = parseInt(micChoice, 10);
    if (audios[idx2]) selectedAudioDeviceId = audios[idx2].deviceId;
  }

  alert('Settings saved. Next time you start camera/stream, it will use these devices.');
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    chooseDevices().catch(err => alert('Error listing devices: ' + err.message));
  });
}
