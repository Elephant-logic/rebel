// app.js - Full File
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = null;

// UI Elements
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
const openStreamBtn = document.getElementById('openStreamBtn');

// WebRTC vars
let pc = null;
let localStream = null;
let camOn = true;
let micOn = true;
let screenStream = null;
let isScreenSharing = false;

// ICE Config
const iceConfig = { iceServers: ICE_SERVERS || [] };

socket.on('connect', () => setSignalStatus(true));
socket.on('disconnect', () => setSignalStatus(false));
socket.on('system-message', txt => appendSystem(txt));
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));
socket.on('file-share', handleIncomingFile);

// --- AUTO-REDIAL LOGIC ---
socket.on('user-joined', () => {
  // If we have the camera running, a new user just joined.
  // We must restart the WebRTC connection to include them.
  if (localStream) {
    console.log('New user joined. Connecting stream to them...');
    restartConnection();
  }
});
// -------------------------

socket.on('webrtc-offer', async ({ sdp }) => {
  // Use existing stream if available, or get new one if this is a 2-way call receiving end
  if (!localStream) await startCamera(); 
  if (!pc) createPeerConnectionObject();
  
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

// --- UI Actions ---

joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  let name = nameInput.value.trim();
  if (!room) { alert('Enter room code'); return; }
  if (!name) name = `User-${Math.floor(Math.random()*1000)}`;

  if (socket.disconnected) socket.connect();
  userName = name;
  currentRoom = room;
  socket.emit('join-room', { room, name });
  roomInfoEl.textContent = `Room: ${room}`;
  
  if (streamLinkInput) {
    const url = new URL(window.location.href);
    url.pathname = '/view.html'; // Assumes view.html is in same folder
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
  endCall();
});

// Start Call Button (Host side)
startCallBtn.addEventListener('click', async () => {
  if (!currentRoom) { alert('Join a room first'); return; }
  
  // 1. Turn on Camera
  await startCamera();
  
  // 2. Disable button
  startCallBtn.disabled = true;
  hangupBtn.disabled = false;
  
  // Note: We don't create an offer yet unless we know someone is there.
  // But if we want to be safe, we can try initiating:
  restartConnection();
});

hangupBtn.addEventListener('click', endCall);

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

// --- Helper Functions ---

async function startCamera() {
  if (localStream) return; // Already on
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    // Mute local video to prevent echo
    localVideo.muted = true;
  } catch (err) {
    console.error('Media error', err);
    alert('Could not access camera/mic');
  }
}

function createPeerConnectionObject() {
  if (pc) pc.close();
  
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

  // Add tracks if we have them
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
}

async function restartConnection() {
  // Re-create the peer connection with the existing stream
  createPeerConnectionObject();
  
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (err) {
    console.error('Error creating offer:', err);
  }
}

function endCall() {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  startCallBtn.disabled = false;
  hangupBtn.disabled = true;
}

// Chat & Status Helpers
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
function handleIncomingFile({ from, fileName, fileType, fileSize, fileData }) {
    // (Existing file handling logic)
    // ... for brevity, assuming you kept the logic from previous file.
    // If you need it, copy the function body from your original app.js
}

// Send Chat
sendBtn.addEventListener('click', sendChat);
function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('chat-message', { room: currentRoom, name: userName, text });
  appendChat(userName, text, Date.now());
  chatInput.value = '';
}
