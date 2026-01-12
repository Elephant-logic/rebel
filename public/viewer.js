// REBEL STREAM VIEWER (STATUS + FULLSCREEN + CHAT)
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
const videoContainer    = $('videoContainer');

const chatLog           = $('chatLog');
const chatInput         = $('chatInput');
const sendBtn           = $('sendBtn');
const emojiStrip        = $('emojiStrip');

// Status helper
function setStatus(text) {
  if (viewerStatus) viewerStatus.textContent = text;
  if (viewerStatusMirror) viewerStatusMirror.textContent = text;
}

// Append chat – no special highlight for this viewer
function appendChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const nameHtml = `<strong>${name}</strong>`;

  line.innerHTML = `${nameHtml} <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// SOCKET EVENTS
socket.on('connect', () => {
  if (!currentRoom) return;
  setStatus('Waiting for stream…');
  socket.emit('join-room', { room: currentRoom, name: myName });
});

socket.on('disconnect', () => {
  setStatus('Disconnected');
});

// Stream offer from host
socket.on('webrtc-offer', async ({ sdp }) => {
  try {
    if (pc) {
      try { pc.close(); } catch (e) {}
    }
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

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'disconnected' ||
          pc.connectionState === 'failed' ||
          pc.connectionState === 'closed') {
        setStatus('Disconnected');
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

// ICE from host
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  try {
    if (!pc || !candidate) return;
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Viewer ICE error:', e);
  }
});

// Chat from host / others
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

// VIEWER CHAT SEND (marked as fromViewer: true, uses chosen name)
function sendChat() {
  if (!chatInput || !currentRoom) return;
  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', {
    room: currentRoom,
    name: myName,
    text,
    fromViewer: true
  });

  // Show my message with myName, same style as everyone
  appendChat(myName, text);
  chatInput.value = '';
}

if (sendBtn) {
  sendBtn.addEventListener('click', sendChat);
}
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
    const hidden = chatSection.style.display === 'none';
    chatSection.style.display = hidden ? 'flex' : 'none';
    toggleChatBtn.textContent = hidden ? 'Hide Chat' : 'Show Chat';
  });
}

// INIT – read room from URL
(function init() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (!room) {
    setStatus('No room specified');
    return;
  }
  currentRoom = room;
  setStatus('Connecting…');
  socket.connect();
})();
