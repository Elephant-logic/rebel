// Rebel Messenger client
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = null;

const signalStatusEl = document.getElementById('signalStatus');
const roomInfoEl = document.getElementById('roomInfo');
const nameInput = document.getElementById('nameInput');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');

const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const emojiStrip = document.getElementById('emojiStrip');

const fileInput = document.getElementById('fileInput');
const sendFileBtn = document.getElementById('sendFileBtn');
const fileNameLabel = document.getElementById('fileNameLabel');

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const startCallBtn = document.getElementById('startCallBtn');
const hangupBtn = document.getElementById('hangupBtn');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const streamLinkInput = document.getElementById('streamLinkInput');

// WebRTC vars
let pc = null;
let localStream = null;
let camOn = true;
let micOn = true;
let screenStream = null;
let isScreenSharing = false;

socket.on('connect', () => setSignalStatus(true));
socket.on('disconnect', () => setSignalStatus(false));

socket.on('system-message', txt => appendSystem(txt));
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));
socket.on('file-share', handleIncomingFile);

socket.on('webrtc-offer', async ({ sdp }) => {
  if (!pc) await createPeerConnection(false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { room: currentRoom, sdp: pc.localDescription });
  } catch (err) {
    console.error('Error handling offer:', err);
  }
});

socket.on('webrtc-answer', async ({ sdp }) => {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (err) {
    console.error('Error handling answer:', err);
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding ICE candidate:', err);
  }
});

joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  let name = nameInput.value.trim();
  if (!room) {
    alert('Enter room code');
    return;
  }
  if (!name) {
    // simple codename
    const animals = ['Wolf','Fox','Hawk','Panther','Tiger','Raven','Viper','Lynx'];
    const adj = ['Silent','Ghost','Rebel','Shadow','Neon','Rapid','Iron','Crimson'];
    const a = animals[Math.floor(Math.random() * animals.length)];
    const b = adj[Math.floor(Math.random() * adj.length)];
    name = `${b}-${a}-${Math.floor(Math.random()*90+10)}`;
    nameInput.value = name;
  }
  if (socket.disconnected) socket.connect();
  userName = name;
  currentRoom = room;
  socket.emit('join-room', { room, name });
  roomInfoEl.textContent = `Room: ${room}`;
  if (streamLinkInput) {
    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.search = '';
    url.searchParams.set('room', room);
    streamLinkInput.value = url.toString();
  }
  joinBtn.disabled = true;
  leaveBtn.disabled = false;
});

leaveBtn.addEventListener('click', () => {
  if (!currentRoom) return;
  socket.emit('leave-room');
  currentRoom = null;
  roomInfoEl.textContent = 'No room';
  joinBtn.disabled = false;
  leaveBtn.disabled = true;
});

// chat
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChat();
  }
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('chat-message', { room: currentRoom, name: userName, text });
  appendChat(userName, text, Date.now());
  chatInput.value = '';
}

// emojis
emojiStrip.addEventListener('click', e => {
  if (!e.target.classList.contains('emoji')) return;
  chatInput.value += e.target.textContent;
  chatInput.focus();
});

// files
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) {
    fileNameLabel.textContent = 'No file';
    sendFileBtn.disabled = true;
  } else {
    fileNameLabel.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
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
    appendSystem(`Sent file: ${file.name}`);
    fileInput.value = '';
    fileNameLabel.textContent = 'No file';
    sendFileBtn.disabled = true;
  };
  reader.readAsDataURL(file);
});

function handleIncomingFile({ from, fileName, fileType, fileSize, fileData }) {
  const bytes = Uint8Array.from(atob(fileData), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: fileType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const line = document.createElement('div');
  line.className = 'chat-line';
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${from} sent file:`;
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName || 'file';
  link.textContent = ` ${fileName} (${Math.round(fileSize/1024)} KB)`;
  link.style.color = '#4af3a3';

  line.appendChild(meta);
  line.appendChild(link);
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// WebRTC
const iceConfig = { iceServers: ICE_SERVERS || [] };

startCallBtn.addEventListener('click', async () => {
  if (!currentRoom) {
    alert('Join a room first');
    return;
  }
  await createPeerConnection(true);
});

hangupBtn.addEventListener('click', () => endCall());

toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  toggleCamBtn.textContent = camOn ? 'Camera Off' : 'Camera On';
});

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  toggleMicBtn.textContent = micOn ? 'Mute' : 'Unmute';
});

if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!pc || !localStream) {
      alert('Start a call before sharing your screen');
      return;
    }

    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender && screenTrack) {
          await sender.replaceTrack(screenTrack);
        }
        screenTrack.onended = () => {
          stopScreenShare();
        };
        localVideo.srcObject = screenStream;
        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';
      } catch (err) {
        console.error('Screen share error', err);
        alert('Could not start screen share');
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

  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    const sender = pc && pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && camTrack) {
      sender.replaceTrack(camTrack);
    }
    localVideo.srcObject = localStream;
  } else {
    localVideo.srcObject = null;
  }

  isScreenSharing = false;
  if (shareScreenBtn) {
    shareScreenBtn.textContent = 'Share Screen';
  }
}


async function createPeerConnection(isCaller) {
  if (pc) endCall();
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    console.error('Media error', err);
    alert('Could not access camera/mic');
    return;
  }

  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  if (isCaller) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  }

  startCallBtn.disabled = true;
  hangupBtn.disabled = false;
}

function endCall() {
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  isScreenSharing = false;
  if (shareScreenBtn) {
    shareScreenBtn.textContent = 'Share Screen';
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  startCallBtn.disabled = false;
  hangupBtn.disabled = true;
}

// helpers
function setSignalStatus(connected) {
  if (connected) {
    signalStatusEl.textContent = 'Connected';
    signalStatusEl.classList.remove('status-disconnected');
    signalStatusEl.classList.add('status-connected');
  } else {
    signalStatusEl.textContent = 'Disconnected';
    signalStatusEl.classList.remove('status-connected');
    signalStatusEl.classList.add('status-disconnected');
  }
}

function appendChat(name, text, ts) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const meta = document.createElement('span');
  meta.className = 'meta';
  const time = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  meta.textContent = `${name} • ${time}:`;
  const body = document.createElement('span');
  body.textContent = ' ' + text;
  line.appendChild(meta);
  line.appendChild(body);
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendSystem(text) {
  const line = document.createElement('div');
  line.className = 'chat-line system';
  line.textContent = text;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}
