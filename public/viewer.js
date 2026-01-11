// VIEWER CLIENT - VIDEO + CHAT
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random()*1000)}`;
const iceConfig = { iceServers: ICE_SERVERS || [] };

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

// 1. JOIN LOGIC
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
  setStatus('Waiting for Stream...');
  socket.emit('join-room', { room: currentRoom, name: myName });
});

socket.on('disconnect', () => setStatus('Disconnected'));

// 2. VIDEO LOGIC (The Simple/Stable Version)
socket.on('webrtc-offer', async ({ sdp }) => {
  setStatus('Stream Found!');
  
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    viewerVideo.srcObject = event.streams[0];
    setStatus('LIVE');
    if (statusEl) {
        statusEl.style.background = '#4af3a3';
        statusEl.style.color = '#000';
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: event.candidate });
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { room: currentRoom, sdp: pc.localDescription });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// 3. UI CONTROLS
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    if (videoContainer.requestFullscreen) videoContainer.requestFullscreen();
    else if (viewerVideo.webkitEnterFullscreen) viewerVideo.webkitEnterFullscreen();
  } else {
    document.exitFullscreen();
  }
});

unmuteBtn.addEventListener('click', () => {
  viewerVideo.muted = !viewerVideo.muted;
  unmuteBtn.textContent = viewerVideo.muted ? '🔇 Unmute' : '🔊 Mute';
});

// 4. CHAT LOGIC
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

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
  line.style.marginBottom = '6px';
  line.style.wordBreak = 'break-word';
  
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const color = name === 'You' ? '#4af3a3' : '#9ba3c0';
  
  line.innerHTML = `<span style="color:${color}; font-size:0.75rem; font-weight:bold;">${name} • ${time}</span><br>${text}`;
  
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}
