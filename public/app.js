// app.js - STABLE HOST
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = null;
let pc = null;
let localStream = null;
let camOn = true;
let micOn = true;
// SAFETY LOCK: Prevents restarting twice in a row
let isNegotiating = false; 

// UI Refs
const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const nameInput = document.getElementById('nameInput');
const startCallBtn = document.getElementById('startCallBtn');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const emojiStrip = document.getElementById('emojiStrip');
const streamLinkInput = document.getElementById('streamLinkInput');

const iceConfig = { iceServers: ICE_SERVERS || [] };

// 1. Join
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  const name = nameInput.value.trim() || 'Host';
  if (!room) return alert('Enter Room');
  
  currentRoom = room;
  userName = name;
  socket.connect();
  socket.emit('join-room', { room, name });
  
  joinBtn.disabled = true;
  document.getElementById('roomInfo').textContent = `Room: ${room}`;
  
  // Generate Link
  const url = new URL(window.location.href);
  url.pathname = '/view.html';
  url.searchParams.set('room', room);
  if (streamLinkInput) streamLinkInput.value = url.toString();
});

// 2. Start Camera
startCallBtn.addEventListener('click', async () => {
  if (!currentRoom) return alert('Join Room First');
  await startCamera();
  startCallBtn.disabled = true;
  startCallBtn.textContent = 'Streaming Active';
});

// 3. STABLE AUTO-CONNECT
socket.on('user-joined', () => {
  // If we are already busy connecting, IGNORE this signal
  if (isNegotiating) return;

  if (localStream) {
    console.log('User joined. Starting stable connection...');
    restartConnection();
  }
});

async function startCamera() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; 
  } catch (err) {
    alert('Camera Error: ' + err.message);
  }
}

async function restartConnection() {
  // 1. Set Lock
  isNegotiating = true;

  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };
  
  // Add Tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (err) {
    console.error(err);
  }

  // 2. Remove Lock after 3 seconds (allows system to settle)
  setTimeout(() => {
    isNegotiating = false;
  }, 3000);
}

// 4. Signaling & Chat
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));

// Chat UI
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

emojiStrip.addEventListener('click', e => {
  if (e.target.classList.contains('emoji')) {
    chatInput.value += e.target.textContent;
    chatInput.focus();
  }
});

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
