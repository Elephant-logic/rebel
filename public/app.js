// Rebel Messenger client

const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';

let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// device management
let videoDevices = [];
let audioDevices = [];
let currentVideoIndex = 0;
let currentAudioIndex = 0;

// ICE
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Helpers
const $ = (id) => document.getElementById(id);

// UI elements
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const signalStatus = $('signalStatus');
const roomInfo = $('roomInfo');

const localVideo = $('localVideo');
const remoteVideo = $('remoteVideo');

const startCallBtn = $('startCallBtn');
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

// --------- STATUS ---------

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

// --------- DEVICES ---------

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

  // replace localStream
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }
  localStream = newStream;
  if (localVideo) localVideo.srcObject = localStream;

  // if in call, replace track on sender
  if (pc) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    const newVideoTrack = localStream.getVideoTracks()[0];
    if (sender && newVideoTrack) {
      sender.replaceTrack(newVideoTrack);
    }
  }
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

  let vIndex = parseInt(vChoice, 10);
  let aIndex = parseInt(aChoice, 10);

  if (!Number.isNaN(vIndex) && vIndex >= 0 && vIndex < videoDevices.length) {
    currentVideoIndex = vIndex;
  }
  if (!Number.isNaN(aIndex) && aIndex >= 0 && aIndex < audioDevices.length) {
    currentAudioIndex = aIndex;
  }

  // apply new selection
  const newStream = await getUserMediaStream();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }
  localStream = newStream;
  if (localVideo) localVideo.srcObject = localStream;

  if (pc) {
    // replace both tracks if needed
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
}

// --------- JOIN / LEAVE ---------

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

    // generate stream link
    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.searchParams.set('room', room);
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    cleanupCall();
    socket.disconnect();
    window.location.reload();
  });
}

socket.on('joined-room', ({ room }) => {
  if (roomInfo) roomInfo.textContent = room;
});

// --------- CHAT ---------

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

socket.on('chat-message', ({ name, text, ts }) => {
  appendChatLine(name || 'Anon', text, ts || Date.now());
});

if (sendBtn && chatInput) {
  sendBtn.addEventListener('click', () => {
    const text = (chatInput.value || '').trim();
    if (!text || !currentRoom) return;
    const ts = Date.now();
    // server will broadcast to everyone (including us)
    socket.emit('chat-message', {
      room: currentRoom,
      name: userName,
      text,
      ts
    });
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

// --------- FILE SHARE ---------

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
      const dataUrl = reader.result;
      socket.emit('file-share', {
        room: currentRoom,
        name: userName,
        fileName: f.name,
        dataUrl
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

// --------- WEBRTC CALL ---------

function createPeerConnection() {
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  pc.ontrack = (e) => {
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
  if (!pc) createPeerConnection();

  // add tracks once
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      const already = pc.getSenders().some((s) => s.track === track);
      if (!already) pc.addTrack(track, localStream);
    });
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('webrtc-offer', {
    room: currentRoom,
    sdp: pc.localDescription
  });

  if (startCallBtn) startCallBtn.disabled = true;
  if (hangupBtn) hangupBtn.disabled = false;
}

socket.on('webrtc-offer', async ({ sdp }) => {
  if (!currentRoom) return;
  await initLocalStream();
  if (!pc) createPeerConnection();

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      const already = pc.getSenders().some((s) => s.track === track);
      if (!already) pc.addTrack(track, localStream);
    });
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit('webrtc-answer', {
    room: currentRoom,
    sdp: pc.localDescription
  });

  if (startCallBtn) startCallBtn.disabled = true;
  if (hangupBtn) hangupBtn.disabled = false;
});

socket.on('webrtc-answer', async ({ sdp }) => {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding ICE candidate', err);
  }
});

function cleanupCall() {
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
  if (remoteVideo) remoteVideo.srcObject = null;
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
  if (startCallBtn) startCallBtn.disabled = false;
  if (hangupBtn) hangupBtn.disabled = true;
}

// Screen share
async function toggleScreenShare() {
  if (!pc) {
    alert('Start a call first');
    return;
  }

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = pc.getSenders().find(
        (s) => s.track && s.track.kind === 'video'
      );
      if (sender && screenTrack) {
        sender.replaceTrack(screenTrack);
      }
      if (localVideo) localVideo.srcObject = screenStream;
      isScreenSharing = true;
      if (shareScreenBtn) shareScreenBtn.textContent = 'Stop Screen';

      screenTrack.onended = () => {
        stopScreenShare();
      };
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
    const sender = pc.getSenders().find(
      (s) => s.track && s.track.kind === 'video'
    );
    if (sender && camTrack) {
      sender.replaceTrack(camTrack);
    }
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// Camera / Mic toggles
function toggleCamera() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  if (toggleCamBtn) {
    toggleCamBtn.textContent = videoTrack.enabled ? 'Camera Off' : 'Camera On';
  }
}

function toggleMic() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  if (toggleMicBtn) {
    toggleMicBtn.textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
  }
}

// --------- BUTTON WIRING ---------

if (startCallBtn) startCallBtn.addEventListener('click', startCall);
if (hangupBtn) hangupBtn.addEventListener('click', cleanupCall);
if (shareScreenBtn) shareScreenBtn.addEventListener('click', toggleScreenShare);
if (toggleCamBtn) toggleCamBtn.addEventListener('click', toggleCamera);
if (toggleMicBtn) toggleMicBtn.addEventListener('click', toggleMic);
if (changeCamBtn) changeCamBtn.addEventListener('click', () => {
  switchCamera().catch((err) => console.error('switchCamera error', err));
});
if (settingsBtn) settingsBtn.addEventListener('click', () => {
  openSettings().catch((err) => console.error('settings error', err));
});

// Stream link open (viewer)
if (openStreamBtn && streamLinkInput) {
  openStreamBtn.addEventListener('click', () => {
    const url = streamLinkInput.value;
    if (!url) return;
    window.open(url, '_blank');
  });
}
