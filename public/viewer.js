// ==========================
// Rebel Stream Viewer
// ==========================
const socket = io({ autoConnect: false });

// DOM
const viewerVideo = document.getElementById('viewerVideo');
const muteBtn = document.getElementById('muteBtn');
const popupBtn = document.getElementById('popupBtn');
const viewerStatus = document.getElementById('viewerStatus');
const streamStatus = document.getElementById('streamStatus');
const viewChatLog = document.getElementById('viewChatLog');
const viewChatInput = document.getElementById('viewChatInput');
const viewSendBtn = document.getElementById('viewSendBtn');
const viewEmojiStrip = document.getElementById('viewEmojiStrip');

// popup elements
const overlay = document.getElementById('videoOverlay');
const overlayVideo = document.getElementById('overlayVideo');
const overlayClose = document.getElementById('overlayClose');

// State
let room = null;
let streamRoom = null;
let viewerPC = null;
let audioMuted = true;
let myName = `Viewer-${Math.floor(Math.random() * 1000)}`;

// ICE config from config/ice.js
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ==========================
// Query params
// ==========================
const params = new URLSearchParams(window.location.search);
room = params.get('room');
if (!room) {
  alert('Missing ?room= in URL');
  throw new Error('No room param');
}
streamRoom = `stream-${room}`;

// ==========================
// Helpers
// ==========================
function appendChat(name, text) {
  const div = document.createElement('div');
  div.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> ${text}`;
  viewChatLog.appendChild(div);
  viewChatLog.scrollTop = viewChatLog.scrollHeight;
}

function setViewerStatus(connected) {
  viewerStatus.textContent = connected ? 'Connected' : 'Disconnected';
  viewerStatus.className = connected ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

// ==========================
// WebRTC
// ==========================
async function createViewerPC() {
  viewerPC = new RTCPeerConnection(iceConfig);

  viewerPC.ontrack = ({ streams }) => {
    const stream = streams[0];
    viewerVideo.srcObject = stream;
    overlayVideo.srcObject = stream;
    streamStatus.textContent = 'LIVE';
  };

  viewerPC.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('webrtc-ice-stream', {
        candidate: e.candidate,
        streamRoom
      });
    }
  };
}

// ==========================
// Socket events
// ==========================
socket.on('connect', () => setViewerStatus(true));
socket.on('disconnect', () => setViewerStatus(false));

// Host broadcast offer
socket.on('webrtc-offer-stream', async ({ sdp }) => {
  await createViewerPC();
  await viewerPC.setRemoteDescription(new RTCSessionDescription(sdp));
  const ans = await viewerPC.createAnswer();
  await viewerPC.setLocalDescription(ans);
  socket.emit('webrtc-answer-stream', { sdp: ans, streamRoom });
  streamStatus.textContent = 'Negotiating…';
});

// ICE from host
socket.on('webrtc-ice-stream', async ({ candidate }) => {
  if (viewerPC && candidate) {
    try {
      await viewerPC.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Viewer ICE error:', e);
    }
  }
});

// Chat from room
socket.on('chat-message', ({ name, text }) => {
  appendChat(name || 'Anon', text);
});

// ==========================
// UI events
// ==========================
muteBtn.onclick = () => {
  audioMuted = !audioMuted;
  viewerVideo.muted = audioMuted;
  overlayVideo.muted = audioMuted;
  muteBtn.textContent = audioMuted ? 'Unmute' : 'Mute';
};

// Popup fullscreen (overlay)
popupBtn.onclick = () => {
  overlay.classList.remove('hidden');
};

overlayClose.onclick = () => {
  overlay.classList.add('hidden');
};

// Emoji strip (same idea as main chat)
viewEmojiStrip.onclick = (e) => {
  if (e.target.classList.contains('emoji')) {
    viewChatInput.value += e.target.textContent;
    viewChatInput.focus();
  }
};

// Send chat
viewSendBtn.onclick = () => {
  const text = viewChatInput.value.trim();
  if (!text) return;
  viewChatInput.value = '';

  // show immediately in your chat log
  appendChat(myName, text);

  // send to main room so host + others see it
  socket.emit('chat-message', {
    room,
    name: myName,
    text
  });
};

viewChatInput.onkeydown = (e) => {
  if (e.key === 'Enter') {
    viewSendBtn.onclick();
  }
};

// ==========================
// Init
// ==========================
socket.connect();

// join main room for chat + /stream-room for broadcast
socket.emit('join-room', { room, name: myName });
socket.emit('join-stream', { streamRoom });

// mute by default (mobile autoplay rules)
viewerVideo.muted = audioMuted;
overlayVideo.muted = audioMuted;
setViewerStatus(false);
