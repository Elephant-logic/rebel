// VIEWER – SIMPLE RECEIVER
const socket = io({ autoConnect: false });

let currentRoom = null;
let viewerPC = null;
let myName = `Viewer-${Math.floor(Math.random() * 1000)}`;

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM
const viewerVideo  = document.getElementById('viewerVideo');
const statusEl     = document.getElementById('status');
const muteBtn      = document.getElementById('muteBtn');
const fullscreenBtn= document.getElementById('fullscreenBtn');
const chatLog      = document.getElementById('chatLog');
const chatInput    = document.getElementById('chatInput');
const sendBtn      = document.getElementById('sendBtn');
const emojiStrip   = document.getElementById('emojiStrip');

let muted = true;

// ----------- Helpers -----------
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function appendChat(name, text, ts = Date.now()) {
  if (!chatLog) return;
  const div = document.createElement('div');
  div.className = 'chat-line';
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const who = name === 'You'
    ? `<span style="color:#4af3a3">${name}</span>`
    : `<strong>${name}</strong>`;
  div.innerHTML = `${who} <small>${time}</small>: ${text}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function createViewerPC() {
  if (viewerPC) {
    try { viewerPC.close(); } catch (e) {}
  }
  viewerPC = new RTCPeerConnection(iceConfig);

  viewerPC.ontrack = (ev) => {
    const stream = ev.streams[0];
    if (viewerVideo) {
      viewerVideo.srcObject = stream;
      viewerVideo.muted = muted;
    }
    setStatus('LIVE');
  };

  viewerPC.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  return viewerPC;
}

// ----------- Socket events -----------
socket.on('connect', () => setStatus('Waiting for Stream…'));
socket.on('disconnect', () => setStatus('Disconnected'));

// Host offer → answer back
socket.on('webrtc-offer', async ({ sdp }) => {
  try {
    await createViewerPC();
    await viewerPC.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await viewerPC.createAnswer();
    await viewerPC.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      room: currentRoom,
      sdp: answer
    });

    setStatus('Connecting…');
  } catch (e) {
    console.error('Viewer offer error:', e);
  }
});

// ICE from host
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!viewerPC || !candidate) return;
  try {
    await viewerPC.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Viewer ICE add error:', e);
  }
});

// Chat from host / others
socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

// ----------- UI -----------
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    if (viewerVideo) viewerVideo.muted = muted;
    muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  });
}

if (fullscreenBtn) {
  fullscreenBtn.addEventListener('click', () => {
    if (!viewerVideo) return;
    if (viewerVideo.requestFullscreen) viewerVideo.requestFullscreen();
    else if (viewerVideo.webkitRequestFullscreen) viewerVideo.webkitRequestFullscreen();
  });
}

function sendChat() {
  const text = chatInput && chatInput.value.trim();
  if (!text || !currentRoom) return;

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

// ----------- INIT -----------
const params = new URLSearchParams(window.location.search);
const room = params.get('room');
if (!room) {
  setStatus('No room specified');
} else {
  currentRoom = room;
  socket.connect();
  setStatus('Connecting…');
  socket.emit('join-room', { room: currentRoom, name: myName });
  // host will send us offers when streaming starts / restarts
}
