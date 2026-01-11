// app.js - Host Client
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = null;
let pc = null;
let localStream = null;
let camOn = true;
let micOn = true;

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
  startCallBtn.textContent = 'Streaming...';
});

// 3. AUTO-CONNECT Logic
socket.on('user-joined', () => {
  if (localStream) {
    console.log('User joined. Waiting 500ms then connecting...');
    // The delay helps stability
    setTimeout(() => {
      restartConnection();
    }, 500);
  }
});

async function startCamera() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Avoid local echo
  } catch (err) {
    alert('Camera Error: ' + err.message);
  }
}

async function restartConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };
  
  // Add Tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
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

// Emoji Support
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
