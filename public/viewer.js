// VIEWER – RECONNECTABLE
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random() * 1000)}`;

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

// DOM
const viewerVideo      = document.getElementById('viewerVideo');
const viewerStatus     = document.getElementById('viewerStatus');
const viewerStatusMirror = document.getElementById('viewerStatusMirror');
const toggleChatBtn    = document.getElementById('toggleChatBtn');
const unmuteBtn        = document.getElementById('unmuteBtn');
const fullscreenBtn    = document.getElementById('fullscreenBtn');

const chatLog          = document.getElementById('chatLog');
const chatInput        = document.getElementById('chatInput');
const sendBtn          = document.getElementById('sendBtn');
const emojiStrip       = document.getElementById('emojiStrip');
const chatSection      = document.querySelector('.chat-section');

let muted = true;
let chatVisible = true;

// ---------- Helpers ----------
function setStatus(text) {
  if (viewerStatus) viewerStatus.textContent = text;
  if (viewerStatusMirror) viewerStatusMirror.textContent = text;
}

function appendChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const who = name === 'You'
    ? `<span style="color:#4af3a3">${name}</span>`
    : `<strong>${name}</strong>`;
  line.innerHTML = `${who} <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function createViewerPC() {
  if (pc) {
    try { pc.close(); } catch (e) {}
  }
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    if (viewerVideo) {
      viewerVideo.srcObject = stream;
      viewerVideo.muted = muted;
    }
    setStatus('LIVE');
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('Disconnected');
      // we don't auto-recreate here; host will send a new offer when ready
    }
  };

  return pc;
}

// ---------- Socket events ----------
socket.on('connect', () => {
  setStatus('Waiting for stream…');
});

socket.on('disconnect', () => {
  setStatus('Disconnected');
});

// Host → viewer: offer
socket.on('webrtc-offer', async ({ sdp }) => {
  try {
    await createViewerPC();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      room: currentRoom,
      sdp: answer
    });

    setStatus('Connecting…');
  } catch (e) {
    console.error('Viewer offer error:', e);
    setStatus('Error');
  }
});

// ICE from host
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Viewer ICE add error:', e);
  }
});

// Chat from host / other viewers
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

// ---------- UI ----------
if (unmuteBtn) {
  unmuteBtn.addEventListener('click', () => {
    muted = !muted;
    if (viewerVideo) viewerVideo.muted = muted;
    unmuteBtn.textContent = muted ? '🔇 Unmute' : '🔊 Mute';
  });
}

if (fullscreenBtn) {
  fullscreenBtn.addEventListener('click', () => {
    const body = document.body;
    const nowFull = !body.classList.contains('fullscreen-mode');
    body.classList.toggle('fullscreen-mode', nowFull);
    fullscreenBtn.textContent = nowFull ? '✕ Exit' : '⛶ Fullscreen';
  });
}

if (toggleChatBtn) {
  toggleChatBtn.addEventListener('click', () => {
    chatVisible = !chatVisible;
    if (chatSection) chatSection.style.display = chatVisible ? 'flex' : 'none';
    toggleChatBtn.textContent = chatVisible ? 'Hide Chat' : 'Show Chat';
  });
}

function sendChat() {
  if (!chatInput || !currentRoom) return;
  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', {
    room: currentRoom,
    name: myName,
    text
  });

  appendChat('You', text);
  chatInput.value = '';
}

if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
}

if (emojiStrip) {
  emojiStrip.addEventListener('click', (e) => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

// ---------- Init ----------
const params = new URLSearchParams(window.location.search);
const room = params.get('room');

if (!room) {
  setStatus('No room specified');
} else {
  currentRoom = room;
  socket.connect();
  setStatus('Connecting…');
  socket.emit('join-room', { room: currentRoom, name: myName });
}
