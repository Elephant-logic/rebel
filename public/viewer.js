// VIEWER – RECONNECTABLE + FIXED CHAT
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random() * 1000)}`;

// Use ICE from config/ice.js if present
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

// DOM
const viewerVideo        = document.getElementById('viewerVideo');
const videoContainer     = document.getElementById('videoContainer');
const statusEl           = document.getElementById('viewerStatus');
const statusMirror       = document.getElementById('viewerStatusMirror');
const fullscreenBtn      = document.getElementById('fullscreenBtn');
const unmuteBtn          = document.getElementById('unmuteBtn');
const toggleChatBtn      = document.getElementById('toggleChatBtn');

const chatLog            = document.getElementById('chatLog');
const chatInput          = document.getElementById('chatInput');
const sendBtn            = document.getElementById('sendBtn');
const emojiStrip         = document.getElementById('emojiStrip');
const chatSection        = document.querySelector('.chat-section');

let muted = true;
let chatVisible = true;

// ---------- Helpers ----------

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
  if (statusMirror) statusMirror.textContent = text;
}

function timeString(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendChat(name, text, ts = Date.now()) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const who = name === 'You'
    ? `<span style="color:#4af3a3">${name}</span>`
    : `<strong>${name}</strong>`;
  line.innerHTML = `${who} <small>${timeString(ts)}</small>: ${text}`;
  if (chatLog) {
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

// Create/replace RTCPeerConnection every time we get a new offer
async function createViewerPC() {
  if (pc) {
    try { pc.close(); } catch (e) {}
  }
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (viewerVideo) {
      viewerVideo.srcObject = stream;
      viewerVideo.muted = muted;
    }
    setStatus('LIVE');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      // Only show "Disconnected" if we don't already have a stream
      if (!viewerVideo || !viewerVideo.srcObject) {
        setStatus('Disconnected');
      }
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
      sdp: pc.localDescription
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
    console.error('Viewer ICE error:', e);
  }
});

// Chat from host / other viewers
socket.on('chat-message', ({ name, text, ts, senderId }) => {
  const label = senderId === socket.id ? 'You' : (name || 'Anon');
  appendChat(label, text, ts);
});

// ---------- UI ----------

if (fullscreenBtn) {
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      if (videoContainer && videoContainer.requestFullscreen) {
        videoContainer.requestFullscreen();
      } else if (viewerVideo && viewerVideo.webkitEnterFullscreen) {
        viewerVideo.webkitEnterFullscreen();
      }
    } else {
      document.exitFullscreen();
    }
  });
}

if (unmuteBtn) {
  unmuteBtn.addEventListener('click', () => {
    if (!viewerVideo) return;
    muted = !muted;
    viewerVideo.muted = muted;
    unmuteBtn.textContent = muted ? '🔇 Unmute' : '🔊 Mute';
    viewerVideo.play().catch(() => {});
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
const roomParam = params.get('room');

if (!roomParam) {
  setStatus('No room specified');
} else {
  currentRoom = roomParam;
  socket.connect();
  setStatus('Connecting…');
  socket.emit('join-room', { room: currentRoom, name: myName });
}
