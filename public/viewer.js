// REBEL STREAM VIEWER
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;

// --- NAME PICKER --- //
function pickName() {
  let raw = prompt('Enter a name for chat (leave blank for random):') || '';
  raw = raw.trim();
  if (raw) return raw;
  return `Viewer-${Math.floor(Math.random() * 1000)}`;
}

let myName = pickName();

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? {
  iceServers: ICE_SERVERS
} : {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// DOM
const $ = id => document.getElementById(id);

const viewerVideo       = $('viewerVideo');
const viewerStatus      = $('viewerStatus');
const viewerStatusMirror= $('viewerStatusMirror');
const toggleChatBtn     = $('toggleChatBtn');
const unmuteBtn         = $('unmuteBtn');
const fullscreenBtn     = $('fullscreenBtn');
const chatLog           = $('chatLog');
const chatInput         = $('chatInput');
const sendBtn           = $('sendBtn');
const emojiStrip        = $('emojiStrip');
const headerTitle       = document.querySelector('.viewer-header strong');

function setStatus(text) {
  if (viewerStatus) viewerStatus.textContent = text;
  if (viewerStatusMirror) viewerStatusMirror.textContent = text;
}

function appendChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  line.innerHTML = `<strong>${name}</strong> <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// SOCKET EVENTS
socket.on('connect', () => {
  if (!currentRoom) return;
  setStatus('Waiting for stream…');
  socket.emit('join-room', { room: currentRoom, name: myName });
});

socket.on('disconnect', () => { setStatus('Disconnected'); });

socket.on('room-update', ({ streamTitle }) => {
  if (headerTitle) headerTitle.textContent = streamTitle || 'Rebel Stream';
  document.title = streamTitle || 'Rebel Stream';
});

socket.on('webrtc-offer', async ({ sdp }) => {
  try {
    if (pc) { try { pc.close(); } catch (e) {} }
    pc = new RTCPeerConnection(iceConfig);

    pc.onicecandidate = (e) => {
      if (e.candidate && currentRoom) {
        socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (viewerVideo && viewerVideo.srcObject !== stream) {
        viewerVideo.srcObject = stream;
        setStatus('LIVE');
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { room: currentRoom, sdp: answer });
  } catch (e) {
    console.error('Viewer offer error:', e);
    setStatus('Error');
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  try {
    if (!pc || !candidate) return;
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) { console.error('Viewer ICE error:', e); }
});

// LISTEN FOR PUBLIC CHAT
socket.on('public-chat', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

// VIEWER CHAT SEND (FIXED: No local append)
function sendChat() {
  if (!chatInput || !currentRoom) return;
  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit('public-chat', {
    room: currentRoom,
    name: myName,
    text,
    fromViewer: true
  });
  // Removed local append to stop duplicates
  chatInput.value = '';
}

if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});
if (emojiStrip) {
  emojiStrip.addEventListener('click', (e) => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

// Controls
if (unmuteBtn && viewerVideo) {
  unmuteBtn.addEventListener('click', () => {
    viewerVideo.muted = !viewerVideo.muted;
    unmuteBtn.textContent = viewerVideo.muted ? '🔇 Unmute' : '🔊 Mute';
  });
}

if (fullscreenBtn) {
  fullscreenBtn.addEventListener('click', () => {
    const isFs = document.body.classList.toggle('fullscreen-mode');
    fullscreenBtn.textContent = isFs ? '✕ Exit' : '⛶ Fullscreen';
  });
}

if (toggleChatBtn) {
  const chatSection = document.querySelector('.chat-section');
  toggleChatBtn.addEventListener('click', () => {
    if (!chatSection) return;
    if (document.body.classList.contains('fullscreen-mode')) {
        const current = getComputedStyle(chatSection).display;
        chatSection.style.display = (current === 'none') ? 'flex' : 'none';
    } else {
        const hidden = chatSection.style.display === 'none';
        chatSection.style.display = hidden ? 'flex' : 'none';
    }
    toggleChatBtn.textContent = chatSection.style.display === 'none' ? 'Show Chat' : 'Hide Chat';
  });
}

// INIT
(function init() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (!room) { setStatus('No room specified'); return; }
  currentRoom = room;
  setStatus('Connecting…');
  socket.connect();
})();
