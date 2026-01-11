// ==========================
//  Rebel Viewer Logic
// ==========================

const socket = io({ autoConnect: false });

// Elements
const viewerVideo = document.getElementById('viewerVideo');
const muteBtn = document.getElementById('muteBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const viewerStatus = document.getElementById('viewerStatus');
const streamStatus = document.getElementById('streamStatus');
const viewChatLog = document.getElementById('viewChatLog');
const viewChatInput = document.getElementById('viewChatInput');
const viewSendBtn = document.getElementById('viewSendBtn');

// State
let room = null;
let currentStreamRoom = null;
let viewerPC = null;
let audioMuted = true;

// ICE config from ice.js
const iceConfig = {
  iceServers: (typeof ICE_SERVERS !== 'undefined' && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length)
    ? ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ==========================
//  Query Params
// ==========================

const params = new URLSearchParams(location.search);
room = params.get('room');
if (!room) {
  alert('No room provided');
  throw new Error('Missing ?room= parameter');
}
currentStreamRoom = `stream-${room}`;

// ==========================
//  Helpers
// ==========================

function appendChat(name, text) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> ${text}`;
  viewChatLog.appendChild(line);
  viewChatLog.scrollTop = viewChatLog.scrollHeight;
}

function updateStatus(connected) {
  if (connected) {
    viewerStatus.textContent = 'Connected';
    viewerStatus.className = 'status-dot status-connected';
  } else {
    viewerStatus.textContent = 'Disconnected';
    viewerStatus.className = 'status-dot status-disconnected';
  }
}

// ==========================
//  Viewer Peer Connection
// ==========================

async function createViewerPC() {
  viewerPC = new RTCPeerConnection(iceConfig);

  viewerPC.ontrack = ({ streams }) => {
    viewerVideo.srcObject = streams[0];
    streamStatus.textContent = 'LIVE';
  };

  viewerPC.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('webrtc-ice-stream', {
        candidate: e.candidate,
        streamRoom: currentStreamRoom
      });
    }
  };
}

// ==========================
//  Socket Events
// ==========================

socket.on('connect', () => updateStatus(true));
socket.on('disconnect', () => updateStatus(false));

// Host triggered offer (broadcast)
socket.on('webrtc-offer-stream', async ({ sdp }) => {
  await createViewerPC();
  await viewerPC.setRemoteDescription(new RTCSessionDescription(sdp));

  const ans = await viewerPC.createAnswer();
  await viewerPC.setLocalDescription(ans);

  socket.emit('webrtc-answer-stream', {
    sdp: ans,
    streamRoom: currentStreamRoom
  });

  streamStatus.textContent = 'Negotiating…';
});

// Stream ICE
socket.on('webrtc-ice-stream', async ({ candidate }) => {
  if (viewerPC && candidate) {
    try {
      await viewerPC.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {}
  }
});

// Chat receive
socket.on('chat-message', ({ name, text }) => {
  appendChat(name, text);
});

// ==========================
//  UI Actions
// ==========================

muteBtn.onclick = () => {
  audioMuted = !audioMuted;
  if (viewerVideo) {
    viewerVideo.muted = audioMuted;
  }
  muteBtn.textContent = audioMuted ? 'Unmute' : 'Mute';
};

fullscreenBtn.onclick = () => {
  if (viewerVideo.requestFullscreen) viewerVideo.requestFullscreen();
};

// Chat send
viewSendBtn.onclick = () => {
  const text = viewChatInput.value.trim();
  if (!text) return;
  viewChatInput.value = '';
  socket.emit('chat-message', {
    room,
    name: 'Viewer',
    text,
    ts: Date.now()
  });
};

// Enter key sends message
viewChatInput.onkeydown = e => {
  if (e.key === 'Enter') viewSendBtn.onclick();
};

// ==========================
//  INIT
// ==========================

socket.connect();
socket.emit('join-stream', { streamRoom: currentStreamRoom });

updateStatus(false);
viewerVideo.muted = audioMuted;
