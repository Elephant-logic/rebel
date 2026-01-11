// HOST - NEW REBEL VERSION (Call + Stream)

const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';

// Call connection
let callPc = null;
// Stream connection (host -> viewers)
let streamPc = null;

// Media
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// Devices
let videoDevices = [];
let audioDevices = [];
let currentVideoIndex = 0;
let currentAudioIndex = 0;

const iceConfig = {
  iceServers: window.REBEL_ICE_SERVERS || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Elements
const $ = (id) => document.getElementById(id);

const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const signalStatus = $('signalStatus');
const roomInfo = $('roomInfo');

const localVideo = $('localVideo');
const remoteVideo = $('remoteVideo');

const startCallBtn = $('startCallBtn');
const startStreamBtn = $('startStreamBtn');
const hangupBtn = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const changeCamBtn = $('changeCamBtn');
const settingsBtn = $('settingsBtn');

const streamLinkInput = $('streamLinkInput');
const openStreamBtn = $('openStreamBtn');

const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const emojiStrip = $('emojiStrip');

const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');

// ---- status ----
socket.on('connect', () => {
  if (signalStatus) {
    signalStatus.textContent = 'Connected';
    signalStatus.classList.remove('status-disconnected');
    signalStatus.classList.add('status-connected');
  }
});

socket.on('disconnect', () => {
  if (signalStatus) {
    signalStatus.textContent = 'Disconnected';
    signalStatus.classList.remove('status-connected');
    signalStatus.classList.add('status-disconnected');
  }
});

// ---- devices ----
async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter((d) => d.kind === 'videoinput');
    audioDevices = devices.filter((d) => d.kind === 'audioinput');
  } catch (err) {
    console.warn('enumerateDevices failed', err);
  }
}

async function getUserMediaStream() {
  const videoConstraint = videoDevices.length
    ? { deviceId: { exact: videoDevices[currentVideoIndex].deviceId } }
    : true;

  const audioConstraint = audioDevices.length
    ? { deviceId: { exact: audioDevices[currentAudioIndex].deviceId } }
    : true;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraint,
    audio: audioConstraint
  });
  return stream;
}

async function initLocalStream() {
  if (localStream) return localStream;

  await refreshDevices();
  localStream = await getUserMediaStream();
  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
  }
  return localStream;
}

async function switchCamera() {
  if (!videoDevices.length) {
    await refreshDevices();
  }
  if (!videoDevices.length) return;

  currentVideoIndex = (currentVideoIndex + 1) % videoDevices.length;

  const newStream = await getUserMediaStream();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }
  localStream = newStream;
  if (localVideo) localVideo.srcObject = localStream;

  // Replace track on call/stream if active
  [callPc, streamPc].forEach((pc) => {
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    const newVideoTrack = localStream.getVideoTracks()[0];
    if (sender && newVideoTrack) sender.replaceTrack(newVideoTrack);
  });
}

async function openSettings() {
  await refreshDevices();

  const videoList = videoDevices
    .map((d, i) => `${i}: ${d.label || 'Camera ' + (i + 1)}`)
    .join('\n') || 'No cameras found';

  const audioList = audioDevices
    .map((d, i) => `${i}: ${d.label || 'Mic ' + (i + 1)}`)
    .join('\n') || 'No mics found';

  const vChoice = prompt(
    `Select camera index:\n${videoList}\n\nCurrent: ${currentVideoIndex}`,
    `${currentVideoIndex}`
  );
  const aChoice = prompt(
    `Select microphone index:\n${audioList}\n\nCurrent: ${currentAudioIndex}`,
    `${currentAudioIndex}`
  );

  const vIndex = parseInt(vChoice, 10);
  const aIndex = parseInt(aChoice, 10);

  if (!Number.isNaN(vIndex) && vIndex >= 0 && vIndex < videoDevices.length) {
    currentVideoIndex = vIndex;
  }
  if (!Number.isNaN(aIndex) && aIndex >= 0 && aIndex < audioDevices.length) {
    currentAudioIndex = aIndex;
  }

  const newStream = await getUserMediaStream();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }
  localStream = newStream;
  if (localVideo) localVideo.srcObject = localStream;

  [callPc, streamPc].forEach((pc) => {
    if (!pc) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];
    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'video' && vTrack) sender.replaceTrack(vTrack);
      if (sender.track && sender.track.kind === 'audio' && aTrack) sender.replaceTrack(aTrack);
    });
  });
}

// ---- join / leave ----
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = (roomInput.value || '').trim();
    userName = (nameInput.value || 'Host').trim();
    if (!room) {
      alert('Enter room code');
      return;
    }
    currentRoom = room;

    socket.connect();
    socket.emit('join-room', { room, name: userName });

    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    if (roomInfo) roomInfo.textContent = room;

    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.searchParams.set('room', room);
    if (streamLinkInput) {
      streamLinkInput.value = url.toString();
    }
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    cleanupAll();
    socket.disconnect();
    window.location.reload();
  });
}

socket.on('joined-room', ({ room }) => {
  if (roomInfo) roomInfo.textContent = room;
});

// ---- chat ----
function appendChatLine(name, text, ts) {
  if (!chatLog) return;
  const row = document.createElement('div');
  row.className = 'chat-line';
  const time = new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  row.innerHTML = `<strong>${name}</strong> <small>${time}</small>: ${text}`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

if (sendBtn && chatInput) {
  sendBtn.addEventListener('click', () => {
    const text = (chatInput.value || '').trim();
    if (!text || !currentRoom) return;
    const ts = Date.now();
    socket.emit('chat-message', { room: currentRoom, name: userName, text, ts });
    chatInput.value = '';
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
}

if (emojiStrip && chatInput) {
  emojiStrip.addEventListener('click', (e) => {
    if (!e.target.classList.contains('emoji')) return;
    chatInput.value += e.target.textContent;
    chatInput.focus();
  });
}

socket.on('chat-message', ({ name, text, ts }) => {
  appendChatLine(name || 'Anon', text, ts || Date.now());
});

// ---- file share ----
if (fileInput && fileNameLabel && sendFileBtn) {
  fileInput.addEventListener('change', () => {
    if (!fileInput.files || !fileInput.files.length) {
      fileNameLabel.textContent = 'No file';
      sendFileBtn.disabled = true;
      return;
    }
    const f = fileInput.files[0];
    fileNameLabel.textContent = f.name;
    sendFileBtn.disabled = false;
  });

  sendFileBtn.addEventListener('click', () => {
    if (!fileInput.files || !fileInput.files.length || !currentRoom) return;
    const f = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      socket.emit('file-share', {
        room: currentRoom,
        name: userName,
        fileName: f.name,
        dataUrl: reader.result
      });
      appendChatLine('You', `Shared file: ${f.name}`, Date.now());
      fileInput.value = '';
      fileNameLabel.textContent = 'No file';
      sendFileBtn.disabled = true;
    };
    reader.readAsDataURL(f);
  });
}

socket.on('file-share', ({ name, fileName, dataUrl }) => {
  if (!chatLog) return;
  const row = document.createElement('div');
  row.className = 'chat-line';
  row.innerHTML = `<strong>${name}</strong>: <a href="${dataUrl}" download="${fileName}">
    Download ${fileName}
  </a>`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// ---- CALL WebRTC ----
function createCallPc() {
  callPc = new RTCPeerConnection(iceConfig);

  callPc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  callPc.ontrack = (e) => {
    if (remoteVideo && e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
    }
  };
}

async function startCall() {
  if (!currentRoom) {
    alert('Join a room first');
    return;
  }
  await initLocalStream();
  if (!callPc) createCallPc();

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      const already = callPc.getSenders().some((s) => s.track === track);
      if (!already) callPc.addTrack(track, localStream);
    });
  }

  const offer = await callPc.createOffer();
  await callPc.setLocalDescription(offer);

  socket.emit('webrtc-offer', {
    room: currentRoom,
    sdp: callPc.localDescription
  });

  if (startCallBtn) startCallBtn.disabled = true;
  if (hangupBtn) hangupBtn.disabled = false;
}

socket.on('webrtc-offer', async ({ sdp }) => {
  if (!currentRoom) return;
  await initLocalStream();
  if (!callPc) createCallPc();

  await callPc.setRemoteDescription(new RTCSessionDescription(sdp));

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      const already = callPc.getSenders().some((s) => s.track === track);
      if (!already) callPc.addTrack(track, localStream);
    });
  }

  const answer = await callPc.createAnswer();
  await callPc.setLocalDescription(answer);

  socket.emit('webrtc-answer', {
    room: currentRoom,
    sdp: callPc.localDescription
  });

  if (startCallBtn) startCallBtn.disabled = true;
  if (hangupBtn) hangupBtn.disabled = false;
});

socket.on('webrtc-answer', async ({ sdp }) => {
  if (!callPc) return;
  await callPc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!callPc || !candidate) return;
  try {
    await callPc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding call ICE', err);
  }
});

// ---- STREAM WebRTC ----
function createStreamPc() {
  streamPc = new RTCPeerConnection(iceConfig);

  streamPc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('stream-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  // Viewer sends back audio? For now, we ignore ontrack; stream is one-way.
  streamPc.ontrack = () => {};
}

async function startStream() {
  if (!currentRoom) {
    alert('Join a room first');
    return;
  }
  await initLocalStream();
  socket.emit('host-join-stream', { room: currentRoom });

  if (!streamPc) createStreamPc();

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      const already = streamPc.getSenders().some((s) => s.track === track);
      if (!already) streamPc.addTrack(track, localStream);
    });
  }

  const offer = await streamPc.createOffer();
  await streamPc.setLocalDescription(offer);

  socket.emit('stream-offer', {
    room: currentRoom,
    sdp: streamPc.localDescription
  });

  if (startStreamBtn) startStreamBtn.textContent = 'Restart Stream';
}

socket.on('stream-answer', async ({ sdp }) => {
  if (!streamPc) return;
  await streamPc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('stream-ice-candidate', async ({ candidate }) => {
  if (!streamPc || !candidate) return;
  try {
    await streamPc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding stream ICE', err);
  }
});

// ---- screen share ----
async function toggleScreenShare() {
  if (!callPc && !streamPc) {
    alert('Start a call or stream first');
    return;
  }

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      [callPc, streamPc].forEach((pc) => {
        if (!pc) return;
        const sender = pc.getSenders().find(
          (s) => s.track && s.track.kind === 'video'
        );
        if (sender && screenTrack) sender.replaceTrack(screenTrack);
      });

      if (localVideo) localVideo.srcObject = screenStream;
      isScreenSharing = true;
      if (shareScreenBtn) shareScreenBtn.textContent = 'Stop Screen';

      screenTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.error('Screen share error', err);
    }
  } else {
    stopScreenShare();
  }
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    [callPc, streamPc].forEach((pc) => {
      if (!pc) return;
      const sender = pc.getSenders().find(
        (s) => s.track && s.track.kind === 'video'
      );
      if (sender && camTrack) sender.replaceTrack(camTrack);
    });
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// ---- camera / mic toggle ----
function toggleCamera() {
  if (!localStream) return;
  const vTrack = localStream.getVideoTracks()[0];
  if (!vTrack) return;
  vTrack.enabled = !vTrack.enabled;
  if (toggleCamBtn) {
    toggleCamBtn.textContent = vTrack.enabled ? 'Camera Off' : 'Camera On';
  }
}

function toggleMic() {
  if (!localStream) return;
  const aTrack = localStream.getAudioTracks()[0];
  if (!aTrack) return;
  aTrack.enabled = !aTrack.enabled;
  if (toggleMicBtn) {
    toggleMicBtn.textContent = aTrack.enabled ? 'Mute' : 'Unmute';
  }
}

// ---- cleanup ----
function cleanupAll() {
  [callPc, streamPc].forEach((pc) => {
    if (pc) pc.close();
  });
  callPc = null;
  streamPc = null;

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;

  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
  if (startCallBtn) startCallBtn.disabled = false;
  if (hangupBtn) hangupBtn.disabled = true;
}

// ---- button wiring ----
if (startCallBtn) startCallBtn.addEventListener('click', () => {
  startCall().catch((err) => console.error('startCall error', err));
});
if (startStreamBtn) startStreamBtn.addEventListener('click', () => {
  startStream().catch((err) => console.error('startStream error', err));
});
if (hangupBtn) hangupBtn.addEventListener('click', cleanupAll);
if (shareScreenBtn) shareScreenBtn.addEventListener('click', () => {
  toggleScreenShare().catch((err) => console.error('share error', err));
});
if (toggleCamBtn) toggleCamBtn.addEventListener('click', toggleCamera);
if (toggleMicBtn) toggleMicBtn.addEventListener('click', toggleMic);
if (changeCamBtn) changeCamBtn.addEventListener('click', () => {
  switchCamera().catch((err) => console.error('switch cam error', err));
});
if (settingsBtn) settingsBtn.addEventListener('click', () => {
  openSettings().catch((err) => console.error('settings error', err));
});
if (openStreamBtn && streamLinkInput) {
  openStreamBtn.addEventListener('click', () => {
    const url = streamLinkInput.value;
    if (!url) return;
    window.open(url, '_blank');
  });
}
