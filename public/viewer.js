// ==========================
//  Rebel Viewer Logic
// ==========================
const socket = io({ autoConnect: false });

const viewerVideo = document.getElementById('viewerVideo');
const muteBtn = document.getElementById('muteBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const viewerStatus = document.getElementById('viewerStatus');
const streamStatus = document.getElementById('streamStatus');
const viewChatLog = document.getElementById('viewChatLog');
const viewChatInput = document.getElementById('viewChatInput');
const viewSendBtn = document.getElementById('viewSendBtn');

let room = null;
let currentStreamRoom = null;
let viewerPC = null;
let audioMuted = true;

const iceConfig = {
  iceServers: (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
    ? ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }]
};

const params = new URLSearchParams(location.search);
room = params.get('room');
if (!room) {
  alert('No room provided (?room=...)');
  throw new Error('Missing room');
}
currentStreamRoom = `stream-${room}`;

function appendChat(name, text) {
  const div = document.createElement('div');
  div.className = 'chat-line';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="meta">[${ts}] <b>${name}:</b></span> ${text}`;
  viewChatLog.appendChild(div);
  viewChatLog.scrollTop = viewChatLog.scrollHeight;
}

function setViewerStatus(on) {
  viewerStatus.textContent = on ? 'Connected' : 'Disconnected';
  viewerStatus.className = on ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

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

socket.on('connect', () => setViewerStatus(true));
socket.on('disconnect', () => setViewerStatus(false));

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

socket.on('webrtc-ice-stream', async ({ candidate }) => {
  if (viewerPC && candidate) {
    await viewerPC.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

socket.on('chat-message', ({ name, text }) => appendChat(name, text));

muteBtn.onclick = () => {
  audioMuted = !audioMuted;
  viewerVideo.muted = audioMuted;
  muteBtn.textContent = audioMuted ? 'Unmute' : 'Mute';
};

fullscreenBtn.onclick = () => {
  if (viewerVideo.requestFullscreen) viewerVideo.requestFullscreen();
};

viewSendBtn.onclick = () => {
  const text = viewChatInput.value.trim();
  if (!text) return;
  viewChatInput.value = '';
  socket.emit('chat-message', {
    room,
    name: 'Viewer',
    text
  });
};

viewChatInput.onkeydown = e => {
  if (e.key === 'Enter') viewSendBtn.onclick();
};

socket.connect();
socket.emit('join-stream', { streamRoom: currentStreamRoom });
viewerVideo.muted = audioMuted;
setViewerStatus(false);
