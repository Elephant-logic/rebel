// VIEWER – connects to stream room & shows video + chat

const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;
let myName = `Viewer-${Math.floor(Math.random() * 1000)}`;

const viewerVideo = document.getElementById('viewerVideo');
const videoContainer = document.getElementById('videoContainer');
const statusEl = document.getElementById('viewerStatus');
const liveBadge = document.getElementById('liveBadge');
const chatLog = document.getElementById('viewerChatLog');
const chatInput = document.getElementById('viewerChatInput');
const sendBtn = document.getElementById('viewerSendBtn');
const emojiStrip = document.getElementById('emojiStrip');
const unmuteBtn = document.getElementById('unmuteBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');

const params = new URLSearchParams(window.location.search);
currentRoom = params.get('room');

const iceConfig = {
  iceServers: window.REBEL_ICE_SERVERS || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setLive(isLive) {
  if (!liveBadge) return;
  if (isLive) {
    liveBadge.textContent = 'Live';
    liveBadge.className = 'badge-live';
  } else {
    liveBadge.textContent = 'Waiting';
    liveBadge.className = 'badge-waiting';
  }
}

function appendChat(name, text, ts) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const time = ts
    ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const nameHtml =
    name === 'You'
      ? `<span style="color:#4af3a3">${name}</span>`
      : `<strong>${name}</strong>`;
  line.innerHTML = `${nameHtml} ${time ? `<small>${time}</small>` : ''}: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function createPc() {
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('stream-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  pc.ontrack = (e) => {
    if (viewerVideo && e.streams[0]) {
      viewerVideo.srcObject = e.streams[0];
      setLive(true);
      setStatus('Live stream');
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      setLive(false);
      setStatus('Disconnected – waiting for host…');
    }
  };
}

async function startViewer() {
  if (!currentRoom) {
    setStatus('Missing room parameter');
    return;
  }
  socket.connect();
  setStatus('Connecting to room…');
  socket.emit('join-stream-room', { room: currentRoom, name: myName });
}

socket.on('joined-stream-room', () => {
  setStatus('Waiting for host stream…');
});

socket.on('stream-offer', async ({ sdp }) => {
  if (!pc) createPc();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('stream-answer', {
    room: currentRoom,
    sdp: pc.localDescription
  });
});

socket.on('stream-ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Viewer add ICE error', err);
  }
});

// viewer chat
if (sendBtn && chatInput) {
  sendBtn.addEventListener('click', () => {
    const text = (chatInput.value || '').trim();
    if (!text || !currentRoom) return;
    const ts = Date.now();
    socket.emit('stream-chat-message', {
      room: currentRoom,
      name: myName,
      text,
      ts
    });
    chatInput.value = '';
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
}

if (emojiStrip && chatInput) {
  emojiStrip.addEventListener('click', (e) => {
    if (!e.target.classList.contains('emoji')) return;
    chatInput.value += e.target.textContent;
    chatInput.focus();
  });
}

socket.on('stream-chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

// audio + fullscreen
if (unmuteBtn && viewerVideo) {
  unmuteBtn.addEventListener('click', () => {
    viewerVideo.muted = !viewerVideo.muted;
    unmuteBtn.textContent = viewerVideo.muted ? 'Unmute' : 'Mute';
  });
}

if (fullscreenBtn && videoContainer) {
  fullscreenBtn.addEventListener('click', () => {
    const elem = videoContainer;
    if (!document.fullscreenElement) {
      if (elem.requestFullscreen) elem.requestFullscreen();
      else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  });
}

startViewer();
