// viewer.js - Updated with Chat & Controls
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random()*1000)}`;

// Elements
const viewerVideo = document.getElementById('viewerVideo');
const videoContainer = document.getElementById('videoContainer');
const statusEl = document.getElementById('viewerStatus');
const unmuteBtn = document.getElementById('unmuteBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');

const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const emojiStrip = document.getElementById('emojiStrip');

const iceConfig = { iceServers: ICE_SERVERS || [] };

// --- 1. SETUP ---
const params = new URLSearchParams(window.location.search);
const room = params.get('room');

if (room) {
  currentRoom = room;
  socket.connect();
  setStatus('Connecting...');
} else {
  setStatus('No Room ID');
}

socket.on('connect', () => {
  setStatus('Joining...');
  socket.emit('join-room', { room: currentRoom, name: myName });
  
  // Poke host if needed
  setTimeout(() => {
    if (!pc) socket.emit('join-room', { room: currentRoom, name: myName });
  }, 1500);
});

socket.on('disconnect', () => setStatus('Disconnected'));

// --- 2. VIDEO LOGIC ---

socket.on('webrtc-offer', async ({ sdp }) => {
  setStatus('Live');
  
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    viewerVideo.srcObject = event.streams[0];
    setStatus('LIVE (Signal)');
    statusEl.classList.add('status-live');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: event.candidate });
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { room: currentRoom, sdp: pc.localDescription });
  } catch (err) {
    console.error(err);
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// --- 3. CONTROLS ---

// Fullscreen
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    if (videoContainer.requestFullscreen) videoContainer.requestFullscreen();
    else if (viewerVideo.webkitEnterFullscreen) viewerVideo.webkitEnterFullscreen(); // iOS
  } else {
    document.exitFullscreen();
  }
});

// Unmute
unmuteBtn.addEventListener('click', () => {
  viewerVideo.muted = !viewerVideo.muted;
  unmuteBtn.textContent = viewerVideo.muted ? '🔇 Unmute' : '🔊 Mute';
});

// --- 4. CHAT LOGIC ---

socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

// Emojis
emojiStrip.addEventListener('click', e => {
  if (e.target.classList.contains('emoji')) {
    chatInput.value += e.target.textContent;
    chatInput.focus();
  }
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  
  socket.emit('chat-message', { room: currentRoom, name: myName, text });
  appendChat('You', text, Date.now());
  chatInput.value = '';
}

function appendChat(name, text, ts) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.style.marginBottom = '4px';
  
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  // Color code "You" vs others
  const color = name === 'You' ? '#4af3a3' : '#9ba3c0';
  
  line.innerHTML = `<span style="color:${color}; font-size:0.75rem;">${name} • ${time}</span><br>${text}`;
  
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}
