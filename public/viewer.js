// REBEL STREAM VIEWER (STATUS + FULLSCREEN FIXED)
const socket = io({
  autoConnect: false
});

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random() * 1000)}`;

const iceConfig =
  typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length
    ? { iceServers: ICE_SERVERS }
    : {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      };

// DOM helpers
const $ = (id) => document.getElementById(id);

const statusEl = $('viewerStatus');
const statusMirrorEl = $('viewerStatusMirror');
const videoEl = $('viewerVideo');
const chatLog = $('viewerChatLog');
const chatInput = $('viewerChatInput');
const sendBtn = $('viewerSendBtn');
const emojiStrip = $('viewerEmojiStrip');
const fullscreenBtn = $('fullscreenBtn');
const toggleChatBtn = $('toggleChatBtn');
const unmuteBtn = $('unmuteBtn');

// ---------- Status ----------
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
  if (statusMirrorEl) statusMirrorEl.textContent = text;
}

// ---------- Chat helpers ----------
function appendChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  const who =
    name === 'You'
      ? `<span style="color:#4af3a3">${name}</span>`
      : name === 'System'
      ? `<span style="color:#9ba3c0">${name}</span>`
      : `<strong>${name}</strong>`;
  line.innerHTML = `${who} <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------- Peer connection ----------
function createViewerPC() {
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
  }
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (videoEl) {
      videoEl.srcObject = stream;
      setStatus('LIVE');
    }
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
    if (
      pc.connectionState === 'failed' ||
      pc.connectionState === 'disconnected'
    ) {
      if (!videoEl || !videoEl.srcObject) setStatus('Disconnected');
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

socket.on('webrtc-offer', async ({ sdp }) => {
  if (!sdp || !currentRoom) return;

  createViewerPC();

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      room: currentRoom,
      sdp: answer
    });
  } catch (e) {
    console.error('Viewer offer handling error:', e);
    setStatus('Error');
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Viewer ICE error:', e);
  }
});

// Chat from host / others
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

// ---------- UI events ----------
function sendChat() {
  if (!currentRoom || !chatInput) return;
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

// fake fullscreen (CSS class toggle)
if (fullscreenBtn) {
  fullscreenBtn.addEventListener('click', () => {
    const body = document.body;
    const isFs = body.classList.toggle('fullscreen-mode');
    fullscreenBtn.textContent = isFs ? '✕ Exit' : '⛶ Fullscreen';
  });
}

// show/hide chat
if (toggleChatBtn) {
  toggleChatBtn.addEventListener('click', () => {
    const panel = document.querySelector('.chat-section');
    if (!panel) return;
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? 'flex' : 'none';
    toggleChatBtn.textContent = hidden ? 'Hide Chat' : 'Show Chat';
  });
}

// mute / unmute local playback
if (unmuteBtn && videoEl) {
  unmuteBtn.addEventListener('click', () => {
    videoEl.muted = !videoEl.muted;
    unmuteBtn.textContent = videoEl.muted ? '🔇 Unmute' : '🔊 Mute';
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
  socket.emit('join-room', {
    room: currentRoom,
    name: myName,
    clientType: 'viewer' // IMPORTANT: viewers never become host
  });
}
