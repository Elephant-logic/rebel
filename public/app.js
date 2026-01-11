// HOST – CALL + STREAM (SEPARATE)
const socket = io({ autoConnect: false });

let currentRoom = null;     // main chat / call room
let streamRoom = null;      // separate random stream channel
let userName = 'Host';

// PeerConnections
let callPc = null;          // 2-way call in chat
let streamPc = null;        // 1-way stream to view.html

// Media
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// Devices
let videoDevices = [];
let audioDevices = [];
let currentVideoDeviceId = null;
let currentAudioDeviceId = null;

// ICE config
const iceConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ] 
};

// DOM helper
const $ = id => document.getElementById(id);

// Elements
const joinBtn        = $('joinBtn');
const leaveBtn       = $('leaveBtn');
const roomInput      = $('roomInput');
const nameInput      = $('nameInput');
const signalStatusEl = $('signalStatus');
const roomInfo       = $('roomInfo');
const hostNameLabel  = $('hostNameLabel');

const localVideo     = $('localVideo');
const remoteVideo    = $('remoteVideo');
const startCallBtn   = $('startCallBtn');
const startStreamBtn = $('startStreamBtn');
const hangupBtn      = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const swapCamBtn     = $('swapCamBtn');
const toggleCamBtn   = $('toggleCamBtn');
const toggleMicBtn   = $('toggleMicBtn');
const streamLinkInput= $('streamLinkInput');
const openStreamBtn  = $('openStreamBtn');

const chatLog        = $('chatLog');
const chatInput      = $('chatInput');
const sendBtn        = $('sendBtn');
const emojiStrip     = $('emojiStrip');
const fileInput      = $('fileInput');
const sendFileBtn    = $('sendFileBtn');
const fileNameLabel  = $('fileNameLabel');

const sharedPreview  = $('sharedPreview');
const chatTabChat    = $('chatTabChat');
const chatTabShared  = $('chatTabShared');
const sharedPanel    = $('sharedPanel');

const settingsBtn      = $('settingsBtn');
const settingsModal    = $('settingsModal');
const settingsCloseBtn = $('settingsCloseBtn');
const cameraSelect     = $('cameraSelect');
const micSelect        = $('micSelect');

// ---------- Socket status ----------
socket.on('connect', () => {
  if (!signalStatusEl) return;
  signalStatusEl.textContent = 'Connected';
  signalStatusEl.classList.add('status-connected');
  signalStatusEl.classList.remove('status-disconnected');
});

socket.on('disconnect', () => {
  if (!signalStatusEl) return;
  signalStatusEl.textContent = 'Disconnected';
  signalStatusEl.classList.add('status-disconnected');
  signalStatusEl.classList.remove('status-connected');
});

// ---------- Join / Leave room ----------
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput?.value.trim();
    const name = nameInput?.value.trim();
    if (!room) return alert('Enter main room name');

    userName    = name || 'Host';
    currentRoom = room;

    if (hostNameLabel) {
      hostNameLabel.textContent = `${userName} (Host)`;
    }

    socket.connect();
    socket.emit('join-room', { room: currentRoom, name: userName });

    joinBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = false;
    if (roomInfo) roomInfo.textContent = `Room: ${currentRoom}`;

    // viewer link will be filled once streamRoom exists
    if (streamLinkInput) streamLinkInput.value = '';
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    if (currentRoom) {
      socket.emit('leave-room', { room: currentRoom });
    }
    if (streamRoom) {
      socket.emit('leave-room', { room: streamRoom });
    }

    cleanupAll();
    currentRoom = null;
    streamRoom  = null;

    if (joinBtn) joinBtn.disabled = false;
    leaveBtn.disabled = true;
    if (roomInfo) roomInfo.textContent = 'No room';
    if (streamLinkInput) streamLinkInput.value = '';
  });
}

function cleanupAll() {
  if (callPc)   { callPc.close();   callPc = null; }
  if (streamPc) { streamPc.close(); streamPc = null; }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  if (localVideo)  localVideo.srcObject  = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  if (sharedPreview) sharedPreview.srcObject = null;

  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';

  if (startCallBtn) {
    startCallBtn.disabled = false;
    startCallBtn.textContent = 'Start Call';
  }
  if (startStreamBtn) {
    startStreamBtn.dataset.active = '0';
    startStreamBtn.textContent   = 'Start Stream';
  }
  if (hangupBtn) hangupBtn.disabled = true;
}

// ---------- Media helpers ----------
async function ensureLocalStream() {
  if (localStream) return;

  const constraints = {
    video: currentVideoDeviceId ? { deviceId: { exact: currentVideoDeviceId } } : true,
    audio: currentAudioDeviceId ? { deviceId: { exact: currentAudioDeviceId } } : true
  };

  localStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
  }
  if (sharedPreview) sharedPreview.srcObject = localStream;

  await refreshDevices(); // populate device list after permission
}

// ---------- CALL (2-way, in chat) ----------
if (startCallBtn) {
  startCallBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert('Join main room first');

    try {
      await ensureLocalStream();
    } catch (e) {
      return alert('Camera error: ' + e.message);
    }

    await startCallConnection();

    startCallBtn.disabled = true;
    startCallBtn.textContent = 'Call Active';
    if (hangupBtn) hangupBtn.disabled = false;
  });
}

async function startCallConnection() {
  if (!currentRoom) return;

  if (callPc) callPc.close();
  callPc = new RTCPeerConnection(iceConfig);

  if (localStream) {
    localStream.getTracks().forEach(t => callPc.addTrack(t, localStream));
  }

  callPc.ontrack = (e) => {
    if (remoteVideo) remoteVideo.srcObject = e.streams[0];
  };

  callPc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
    }
  };

  const offer = await callPc.createOffer();
  await callPc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: currentRoom, sdp: callPc.localDescription });
}

if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    if (callPc) { callPc.close(); callPc = null; }
    if (remoteVideo) remoteVideo.srcObject = null;

    if (startCallBtn) {
      startCallBtn.disabled = false;
      startCallBtn.textContent = 'Start Call';
    }
    hangupBtn.disabled = true;
  });
}

// ---------- STREAM (1-way, separate random room) ----------
if (startStreamBtn) {
  startStreamBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert('Join main room first');

    const active = startStreamBtn.dataset.active === '1';

    if (!active) {
      // starting stream
      try {
        await ensureLocalStream();
      } catch (e) {
        return alert('Camera error: ' + e.message);
      }

      if (!streamRoom) {
        const rand = Math.floor(100000 + Math.random() * 900000);
        streamRoom = `stream-${rand}`;
        socket.emit('join-room', { room: streamRoom, name: `${userName}-stream` });

        const url = new URL(window.location.href);
        url.pathname = '/view.html';
        url.searchParams.set('room', streamRoom);
        if (streamLinkInput) streamLinkInput.value = url.toString();
      }

      await startStreamConnection();
      startStreamBtn.dataset.active = '1';
      startStreamBtn.textContent   = 'Stop Stream';
    } else {
      // stopping stream
      if (streamPc) { streamPc.close(); streamPc = null; }
      startStreamBtn.dataset.active = '0';
      startStreamBtn.textContent    = 'Start Stream';
    }
  });
}

async function startStreamConnection() {
  if (!streamRoom) return;

  if (streamPc) streamPc.close();
  streamPc = new RTCPeerConnection(iceConfig);

  if (localStream) {
    localStream.getTracks().forEach(t => streamPc.addTrack(t, localStream));
  }

  streamPc.onicecandidate = (e) => {
    if (e.candidate && streamRoom) {
      socket.emit('webrtc-ice-candidate', { room: streamRoom, candidate: e.candidate });
    }
  };

  const offer = await streamPc.createOffer();
  await streamPc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: streamRoom, sdp: streamPc.localDescription });
}

// ---------- Screen share (affects both call + stream) ----------
if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!localStream) return alert('Start call or stream first');

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Replace in call
        if (callPc) {
          const sender = callPc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        }
        // Replace in stream
        if (streamPc) {
          const sender = streamPc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        }

        const combined = new MediaStream([screenTrack, ...(localStream?.getAudioTracks() || [])]);
        if (localVideo) localVideo.srcObject = combined;
        if (sharedPreview) sharedPreview.srcObject = combined;

        screenTrack.onended = () => stopScreenShare();
        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';
      } catch (e) {
        console.error('Screen share error', e);
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

  const camTrack = localStream && localStream.getVideoTracks()[0];

  [callPc, streamPc].forEach(pc => {
    if (!pc || !camTrack) return;
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(camTrack);
  });

  if (localVideo) localVideo.srcObject = localStream;
  if (sharedPreview) sharedPreview.srcObject = localStream;

  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// ---------- Camera / Mic toggles ----------
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    toggleCamBtn.textContent = track.enabled ? 'Camera Off' : 'Camera On';
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    toggleMicBtn.textContent = track.enabled ? 'Mute' : 'Unmute';
  });
}

// ---------- Stream link open ----------
if (openStreamBtn && streamLinkInput) {
  openStreamBtn.addEventListener('click', () => {
    if (!streamLinkInput.value) return;
    window.open(streamLinkInput.value, '_blank');
  });
}

// ---------- CHAT ----------
function appendChat(name, text, ts, isSelf = false) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line' + (isSelf ? ' self' : '');
  const time = new Date(ts || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  const who = isSelf ? 'You' : (name || 'User');
  line.innerHTML = `
    <span class="meta">${who}</span>
    <span class="meta">${time}</span>
    <span>${text}</span>
  `;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat() {
  if (!chatInput || !currentRoom) return;
  const text = chatInput.value.trim();
  if (!text) return;

  const payload = {
    room: currentRoom,
    name: userName,
    text,
    ts: Date.now()
  };

  socket.emit('chat-message', payload);
  appendChat(userName, text, payload.ts, true);
  chatInput.value = '';
}

if (sendBtn) {
  sendBtn.addEventListener('click', sendChat);
}
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
}
if (emojiStrip && chatInput) {
  emojiStrip.addEventListener('click', (e) => {
    if (!e.target.classList.contains('emoji')) return;
    chatInput.value += e.target.textContent;
    chatInput.focus();
  });
}

socket.on('chat-message', ({ room, name, text, ts }) => {
  if (room && currentRoom && room !== currentRoom) return;
  appendChat(name, text, ts, false);
});

// ---------- FILES ----------
if (fileInput && sendFileBtn) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) {
      if (fileNameLabel) fileNameLabel.textContent = fileInput.files[0].name;
      sendFileBtn.disabled = false;
    } else {
      if (fileNameLabel) fileNameLabel.textContent = 'No file';
      sendFileBtn.disabled = true;
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
        data: base64
      });
      fileInput.value = '';
      sendFileBtn.disabled = true;
      if (fileNameLabel) fileNameLabel.textContent = 'No file';
    };
    reader.readAsDataURL(file);
  });
}

socket.on('file-share', ({ room, name, fileName, fileType, data }) => {
  if (room && currentRoom && room !== currentRoom) return;
  if (!chatLog) return;

  const link = document.createElement('a');
  link.href = `data:${fileType};base64,${data}`;
  link.download = fileName;
  link.textContent = `${name || 'User'} sent: ${fileName}`;

  const line = document.createElement('div');
  line.className = 'chat-line system';
  line.appendChild(link);
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// ---------- Tabs: Chat / Shared View ----------
if (chatTabChat && chatTabShared) {
  chatTabChat.addEventListener('click', () => {
    chatTabChat.classList.add('active-tab');
    chatTabShared.classList.remove('active-tab');
    if (chatLog) chatLog.classList.remove('hidden');
    if (sharedPanel) sharedPanel.classList.add('hidden');
  });

  chatTabShared.addEventListener('click', () => {
    chatTabShared.classList.add('active-tab');
    chatTabChat.classList.remove('active-tab');
    if (chatLog) chatLog.classList.add('hidden');
    if (sharedPanel) sharedPanel.classList.remove('hidden');
  });
}

// ---------- Device settings / swap cam ----------
async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  videoDevices = devices.filter(d => d.kind === 'videoinput');
  audioDevices = devices.filter(d => d.kind === 'audioinput');

  if (cameraSelect) {
    cameraSelect.innerHTML = '';
    videoDevices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      cameraSelect.appendChild(opt);
    });
  }

  if (micSelect) {
    micSelect.innerHTML = '';
    audioDevices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mic ${i + 1}`;
      micSelect.appendChild(opt);
    });
  }

  if (!currentVideoDeviceId && videoDevices[0]) {
    currentVideoDeviceId = videoDevices[0].deviceId;
  }
  if (!currentAudioDeviceId && audioDevices[0]) {
    currentAudioDeviceId = audioDevices[0].deviceId;
  }

  if (cameraSelect && currentVideoDeviceId) cameraSelect.value = currentVideoDeviceId;
  if (micSelect && currentAudioDeviceId) micSelect.value = currentAudioDeviceId;
}

async function applyDeviceSelection() {
  if (!navigator.mediaDevices) return;
  try {
    const constraints = {
      video: currentVideoDeviceId ? { deviceId: { exact: currentVideoDeviceId } } : true,
      audio: currentAudioDeviceId ? { deviceId: { exact: currentAudioDeviceId } } : true
    };
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);

    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = newStream;

    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.muted = true;
    }
    if (sharedPreview) sharedPreview.srcObject = localStream;

    [callPc, streamPc].forEach(pc => {
      if (!pc || !localStream) return;
      const senders = pc.getSenders();
      localStream.getTracks().forEach(track => {
        const sender = senders.find(s => s.track && s.track.kind === track.kind);
        if (sender) sender.replaceTrack(track);
      });
    });
  } catch (e) {
    console.error('applyDeviceSelection error', e);
  }
}

if (settingsBtn && settingsModal) {
  settingsBtn.addEventListener('click', async () => {
    settingsModal.classList.remove('hidden');
    await refreshDevices();
  });
}
if (settingsCloseBtn && settingsModal) {
  settingsCloseBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });
}
if (cameraSelect) {
  cameraSelect.addEventListener('change', async () => {
    currentVideoDeviceId = cameraSelect.value || null;
    await applyDeviceSelection();
  });
}
if (micSelect) {
  micSelect.addEventListener('change', async () => {
    currentAudioDeviceId = micSelect.value || null;
    await applyDeviceSelection();
  });
}

if (swapCamBtn) {
  swapCamBtn.addEventListener('click', async () => {
    await refreshDevices();
    if (videoDevices.length <= 1) {
      alert('No second camera detected');
      return;
    }
    if (!currentVideoDeviceId) currentVideoDeviceId = videoDevices[0].deviceId;
    const idx = videoDevices.findIndex(d => d.deviceId === currentVideoDeviceId);
    const next = (idx + 1) % videoDevices.length;
    currentVideoDeviceId = videoDevices[next].deviceId;
    if (cameraSelect) cameraSelect.value = currentVideoDeviceId;
    await applyDeviceSelection();
  });
}

// ---------- Signalling: offers / answers / ICE ----------
socket.on('webrtc-offer', async ({ room, sdp }) => {
  try {
    // Only handle call offers in the main chat room
    if (room === currentRoom) {
      await ensureLocalStream();

      if (callPc) callPc.close();
      callPc = new RTCPeerConnection(iceConfig);

      if (localStream) {
        localStream.getTracks().forEach(t => callPc.addTrack(t, localStream));
      }

      callPc.ontrack = (e) => {
        if (remoteVideo) remoteVideo.srcObject = e.streams[0];
      };

      callPc.onicecandidate = (e) => {
        if (e.candidate && currentRoom) {
          socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
        }
      };

      await callPc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await callPc.createAnswer();
      await callPc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { room: currentRoom, sdp: callPc.localDescription });

      if (startCallBtn) {
        startCallBtn.disabled = true;
        startCallBtn.textContent = 'Call Active';
      }
      if (hangupBtn) hangupBtn.disabled = false;
    }
    // NOTE: stream offers are handled by viewer.js, not here.
  } catch (err) {
    console.error('Error handling webrtc-offer on host:', err);
  }
});

socket.on('webrtc-answer', async ({ room, sdp }) => {
  try {
    if (room === currentRoom && callPc) {
      await callPc.setRemoteDescription(new RTCSessionDescription(sdp));
    } else if (room === streamRoom && streamPc) {
      await streamPc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  } catch (err) {
    console.error('Error handling webrtc-answer:', err);
  }
});

socket.on('webrtc-ice-candidate', async ({ room, candidate }) => {
  try {
    if (!candidate) return;
    if (room === currentRoom && callPc) {
      await callPc.addIceCandidate(new RTCIceCandidate(candidate));
    } else if (room === streamRoom && streamPc) {
      await streamPc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Error handling ICE candidate:', err);
  }
});
