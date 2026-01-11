// HOST - FULL FEATURES + GOOGLE STUN
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// FIX: Force Google STUN (Fixes Mobile Black Screen)
const iceConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ] 
};

// Elements
const getEl = (id) => document.getElementById(id);
const joinBtn = getEl('joinBtn');
const roomInput = getEl('roomInput');
const startCallBtn = getEl('startCallBtn');
const hangupBtn = getEl('hangupBtn');
const localVideo = getEl('localVideo');
const toggleCamBtn = getEl('toggleCamBtn');
const toggleMicBtn = getEl('toggleMicBtn');
const shareScreenBtn = getEl('shareScreenBtn');
const streamLinkInput = getEl('streamLinkInput');
const signalStatusEl = getEl('signalStatus');

// Chat & Files
const chatLog = getEl('chatLog');
const chatInput = getEl('chatInput');
const sendBtn = getEl('sendBtn');
const emojiStrip = getEl('emojiStrip');
const fileInput = getEl('fileInput');
const sendFileBtn = getEl('sendFileBtn');
const fileNameLabel = getEl('fileNameLabel');

// 1. STATUS
socket.on('connect', () => {
  if (signalStatusEl) {
    signalStatusEl.textContent = 'Connected';
    signalStatusEl.classList.remove('status-disconnected');
    signalStatusEl.classList.add('status-connected');
  }
});
socket.on('disconnect', () => {
  if (signalStatusEl) {
    signalStatusEl.textContent = 'Disconnected';
    signalStatusEl.classList.remove('status-connected');
    signalStatusEl.classList.add('status-disconnected');
  }
});

// 2. JOIN
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput.value.trim();
    if (!room) return alert("Enter Room Name");
    currentRoom = room;
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    joinBtn.disabled = true;
    const info = getEl('roomInfo');
    if (info) info.textContent = `Room: ${room}`;
    
    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.searchParams.set('room', room);
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

// 3. CAMERA
if (startCallBtn) {
  startCallBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert("Join Room First");
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.muted = true;
      }
      startCallBtn.disabled = true;
      startCallBtn.textContent = "Streaming Active";
      if (hangupBtn) hangupBtn.disabled = false;
    } catch (err) { alert(err.message); }
  });
}

// 4. AUTO-CONNECT
socket.on('user-joined', () => {
  if (localStream) {
    console.log("Viewer joined. Restarting...");
    restartConnection();
  }
});

async function restartConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };
  
  const stream = isScreenSharing ? screenStream : localStream;
  if (stream) stream.getTracks().forEach(t => pc.addTrack(t, stream));

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (e) { console.error(e); }
}

// 5. CHAT & EMOJIS (Restored)
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));
if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

if (emojiStrip) {
  emojiStrip.addEventListener('click', e => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('chat-message', { room: currentRoom, name: userName, text });
  appendChat('You', text, Date.now());
  chatInput.value = '';
}

function appendChat(name, text, ts) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const nameHtml = name === 'You' ? `<span style="color:#4af3a3">${name}</span>` : `<strong>${name}</strong>`;
  line.innerHTML = `${nameHtml} <small>${time}</small>: ${text}`;
  if (chatLog) {
      chatLog.appendChild(line);
      chatLog.scrollTop = chatLog.scrollHeight;
  }
}

// 6. FILES & SCREEN SHARE
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
socket.on('file-share', ({ from, fileName, fileType, fileSize, fileData }) => {
    const link = `<a href="data:${fileType};base64,${fileData}" download="${fileName}" style="color:#4af3a3">Download ${fileName}</a>`;
    appendChat(from, `Sent a file: ${link}`, Date.now());
});

// Signals
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// Buttons
if (toggleCamBtn) toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return;
  localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled);
});
if (toggleMicBtn) toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled);
});
if (hangupBtn) hangupBtn.addEventListener('click', () => {
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (localVideo) localVideo.srcObject = null;
  startCallBtn.disabled = false;
  startCallBtn.textContent = 'Start Call';
});
