// HOST CLIENT - FIXED STREAM & CHAT
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let camOn = true;
let micOn = true;

// FIX: Use the servers from ice.js if available, otherwise fallback
const iceConfig = { 
  iceServers: (typeof ICE_SERVERS !== 'undefined') ? ICE_SERVERS : [
    { urls: 'stun:stun.l.google.com:19302' }
  ] 
};

// Elements
const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const startCallBtn = document.getElementById('startCallBtn');
const hangupBtn = document.getElementById('hangupBtn');
const localVideo = document.getElementById('localVideo');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const streamLinkInput = document.getElementById('streamLinkInput');
const signalStatusEl = document.getElementById('signalStatus');

// Chat & Files
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const emojiStrip = document.getElementById('emojiStrip');
const fileInput = document.getElementById('fileInput');
const sendFileBtn = document.getElementById('sendFileBtn');
const fileNameLabel = document.getElementById('fileNameLabel');

// --- 1. CONNECTION STATUS ---
socket.on('connect', () => updateStatus(true));
socket.on('disconnect', () => updateStatus(false));

function updateStatus(connected) {
  if (!signalStatusEl) return;
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

// --- 2. JOIN ROOM ---
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) return alert("Enter Room Name");
  
  currentRoom = room;
  socket.connect();
  socket.emit('join-room', { room, name: userName });
  
  joinBtn.disabled = true;
  document.getElementById('roomInfo').textContent = `Room: ${room}`;
  
  // Link Generation
  const url = new URL(window.location.href);
  url.pathname = '/view.html';
  url.searchParams.set('room', room);
  if (streamLinkInput) streamLinkInput.value = url.toString();
});

// --- 3. START CAMERA ---
startCallBtn.addEventListener('click', async () => {
  if (!currentRoom) return alert("Join a room first!");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Local mute
    
    startCallBtn.disabled = true;
    startCallBtn.textContent = "Streaming Active";
    if (hangupBtn) hangupBtn.disabled = false;
  } catch (err) {
    alert("Camera Error: " + err.message);
  }
});

// --- 4. AUTO-CONNECT (The Magic Fix) ---
socket.on('user-joined', () => {
  if (localStream) {
    console.log("Viewer joined. Restarting connection...");
    restartConnection();
  }
});

async function restartConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };
  
  // Decide which stream to send (Camera or Screen)
  const stream = isScreenSharing ? screenStream : localStream;
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (e) { console.error(e); }
}

// --- 5. SCREEN SHARE ---
if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!localStream) return alert('Start camera first!');
    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        
        // Replace track in active connection
        if (pc) {
            const sender = pc.getSenders().find(s => s.track.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
        }
        localVideo.srcObject = screenStream;
        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';
        
        screenTrack.onended = () => stopScreenShare();
      } catch (err) { console.error(err); }
    } else {
      stopScreenShare();
    }
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  
  if (localStream && pc) {
    const camTrack = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track.kind === 'video');
    if (sender) sender.replaceTrack(camTrack);
    localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  shareScreenBtn.textContent = 'Share Screen';
}

// --- 6. FILE SHARING ---
if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) {
            fileNameLabel.textContent = fileInput.files[0].name;
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
            fileNameLabel.textContent = 'No file';
            sendFileBtn.disabled = true;
        };
        reader.readAsDataURL(file);
    });
}
// Receive File
socket.on('file-share', ({ from, fileName, fileType, fileSize, fileData }) => {
    const link = `<a href="data:${fileType};base64,${fileData}" download="${fileName}" style="color:#4af3a3">Download ${fileName}</a>`;
    appendChat(from, `Sent a file: ${link}`, Date.now());
});

// --- 7. BUTTONS & CHAT ---
if (toggleCamBtn) toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  toggleCamBtn.textContent = camOn ? 'Camera Off' : 'Camera On';
});

if (toggleMicBtn) toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  toggleMicBtn.textContent = micOn ? 'Mute' : 'Unmute';
});

if (hangupBtn) hangupBtn.addEventListener('click', () => {
  if (pc) pc.close();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  localVideo.srcObject = null;
  startCallBtn.disabled = false;
  startCallBtn.textContent = 'Start Call';
  hangupBtn.disabled = true;
});

// Signals
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// Chat
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));
if (sendBtn) sendBtn.addEventListener('click', sendChat);
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
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}
