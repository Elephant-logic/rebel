// REBEL HOST - FINAL FIXED VERSION
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let pc = null;
let localStream = null;
let camOn = true;
let micOn = true;

const iceConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ] 
};

// UI Elements
const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const startCallBtn = document.getElementById('startCallBtn');
const hangupBtn = document.getElementById('hangupBtn');
const localVideo = document.getElementById('localVideo');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const streamLinkInput = document.getElementById('streamLinkInput');
const signalStatusEl = document.getElementById('signalStatus');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const emojiStrip = document.getElementById('emojiStrip');

// --- 1. CONNECTION STATUS UPDATES (The Missing Part) ---
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

// --- 2. JOIN ROOM ---
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) return alert("Enter Room Name");
  
  currentRoom = room;
  socket.connect(); // This triggers the Green 'Connected' status
  socket.emit('join-room', { room, name: userName });
  
  joinBtn.disabled = true;
  document.getElementById('roomInfo').textContent = `Room: ${room}`;
  
  // Generate Link
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
    localVideo.muted = true; // Mute self
    
    startCallBtn.disabled = true;
    startCallBtn.textContent = "Streaming Active";
    if (hangupBtn) hangupBtn.disabled = false;
  } catch (err) {
    alert("Camera Error: " + err.message);
  }
});

// --- 4. AUTO-CONNECT (When Viewer Joins) ---
socket.on('user-joined', () => {
  if (localStream) {
    console.log("Viewer joined. Connecting...");
    restartConnection();
  }
});

async function restartConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };
  
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (e) { console.error(e); }
}

// --- 5. BUTTONS (Restored) ---
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    toggleCamBtn.textContent = camOn ? 'Camera Off' : 'Camera On';
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    toggleMicBtn.textContent = micOn ? 'Mute' : 'Unmute';
  });
}

if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    if (pc) pc.close();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    localVideo.srcObject = null;
    startCallBtn.disabled = false;
    startCallBtn.textContent = 'Start Call';
    hangupBtn.disabled = true;
  });
}

// --- 6. SIGNALING & CHAT ---
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

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
  line.innerHTML = `<strong>${name}</strong> <small>${time}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}
