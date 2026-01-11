// VIEWER - HANDLES REJOINS
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random()*1000)}`;

// GOOGLE STUN
const iceConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ] 
};

// Elements
const viewerVideo = document.getElementById('viewerVideo');
const videoContainer = document.getElementById('videoContainer');
const statusEl = document.getElementById('viewerStatus');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const emojiStrip = document.getElementById('emojiStrip');
const unmuteBtn = document.getElementById('unmuteBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const toggleChatBtn = document.getElementById('toggleChatBtn');

// 1. JOIN LOGIC
const params = new URLSearchParams(window.location.search);
const room = params.get('room');

if (room) {
  currentRoom = room;
  socket.connect();
  setStatus('Connecting...');
} else { setStatus('No Room ID'); }

socket.on('connect', () => {
  setStatus('Waiting for Stream...');
  socket.emit('join-room', { room: currentRoom, name: myName });
});
socket.on('disconnect', () => setStatus('Disconnected'));

// 2. VIDEO LOGIC
socket.on('webrtc-offer', async ({ sdp }) => {
  setStatus('Stream Found!');
  
  // Clean up old connection if exists
  if (pc) { pc.close(); pc = null; }
  
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    viewerVideo.srcObject = event.streams[0];
    setStatus('LIVE');
    if (statusEl) {
       statusEl.style.background = '#4af3a3';
       statusEl.style.color = '#000';
    }
    viewerVideo.play().catch(e => console.log("Autoplay blocked"));
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

// 3. UI
if (fullscreenBtn) fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    if (videoContainer.requestFullscreen) videoContainer.requestFullscreen();
    else if (viewerVideo.webkitEnterFullscreen) viewerVideo.webkitEnterFullscreen();
  } else { document.exitFullscreen(); }
});

if (unmuteBtn) unmuteBtn.addEventListener('click', () => {
  viewerVideo.muted = !viewerVideo.muted;
  unmuteBtn.textContent = viewerVideo.muted ? '🔇 Unmute' : '🔊 Mute';
  viewerVideo.play();
});

if (toggleChatBtn) toggleChatBtn.addEventListener('click', () => {
    document.body.classList.toggle('theater-mode');
    const isHidden = document.body.classList.contains('theater-mode');
    toggleChatBtn.textContent = isHidden ? 'Show Chat' : 'Hide Chat';
});

// 4. CHAT
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));
if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
if (emojiStrip) emojiStrip.addEventListener('click', e => {
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
  line.style.marginBottom = '5px';
  const nameHtml = name === 'You' ? `<span style="color:#4af3a3">${name}</span>` : `<strong>${name}</strong>`;
  line.innerHTML = `${nameHtml}: ${text}`;
  if (chatLog) {
      chatLog.appendChild(line);
      chatLog.scrollTop = chatLog.scrollHeight;
  }
}
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}
