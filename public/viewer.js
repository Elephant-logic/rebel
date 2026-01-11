// Rebel Stream Viewer – 1-way video + chat

const socket = io();

const url = new URL(window.location.href);
const room = url.searchParams.get('room') || '';

const videoEl       = document.getElementById('viewerVideo');
const viewerStatus  = document.getElementById('viewerStatus');
const chatLog       = document.getElementById('chatLog');
const chatInput     = document.getElementById('chatInput');
const sendBtn       = document.getElementById('sendBtn');
const emojiStrip    = document.getElementById('emojiStrip');
const toggleChatBtn = document.getElementById('toggleChatBtn');
const unmuteBtn     = document.getElementById('unmuteBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');

if (!room) {
  if (viewerStatus) viewerStatus.textContent = 'Missing ?room= code in link';
}

// ICE config (shared with host if ICE_SERVERS is defined)
const iceConfig = typeof ICE_SERVERS !== 'undefined'
  ? { iceServers: ICE_SERVERS }
  : {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

let pc = null;
let isChatHidden = false;
let isMuted      = true;

// ---- Join stream room ----
socket.on('connect', () => {
  if (!room) return;
  socket.emit('join-room', { room, name: 'Viewer' });
  if (viewerStatus) viewerStatus.textContent = `Joined room: ${room}`;
});

// ---- Chat ----
function appendChat(name, text, ts) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';

  const time = new Date(ts || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  const who = name === 'You'
    ? `<span class="meta you">You</span>`
    : `<span class="meta">${name}</span>`;

  line.innerHTML = `${who}<span class="meta">${time}</span>${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat() {
  const text = (chatInput.value || '').trim();
  if (!text || !room) return;
  const ts = Date.now();

  socket.emit('chat-message', {
    room,
    name: 'Viewer',
    text,
    ts
  });

  appendChat('You', text, ts);
  chatInput.value = '';
}

if (sendBtn && chatInput) {
  sendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
}

if (emojiStrip && chatInput) {
  emojiStrip.addEventListener('click', (e) => {
    if (!e.target.classList.contains('emoji')) return;
    chatInput.value += e.target.textContent;
    chatInput.focus();
  });
}

socket.on('chat-message', ({ name, text, ts }) => {
  if (!text) return;
  appendChat(name || 'Host', text, ts);
});

// ---- WebRTC (stream only) ----
socket.on('webrtc-offer', async ({ room: offerRoom, sdp }) => {
  if (!room || offerRoom !== room) return;

  if (viewerStatus) viewerStatus.textContent = 'Receiving stream...';

  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    if (videoEl) {
      videoEl.srcObject = event.streams[0];
      videoEl.play().catch(e => console.log('Autoplay blocked', e));
    }
    if (viewerStatus) {
      viewerStatus.textContent = 'LIVE';
      viewerStatus.style.background = '#4af3a3';
      viewerStatus.style.color = '#000';
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && room) {
      socket.emit('webrtc-ice-candidate', {
        room,
        candidate: event.candidate
      });
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit('webrtc-answer', {
    room,
    sdp: pc.localDescription
  });
});

// ICE from host
socket.on('webrtc-ice-candidate', async ({ room: iceRoom, candidate }) => {
  if (!pc || !candidate || iceRoom !== room) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('viewer addIceCandidate error', err);
  }
});

// ---- UI buttons ----
if (toggleChatBtn && chatLog) {
  toggleChatBtn.addEventListener('click', () => {
    isChatHidden = !isChatHidden;
    document.body.classList.toggle('theater-mode', isChatHidden);
    toggleChatBtn.textContent = isChatHidden ? 'Show Chat' : 'Hide Chat';
  });
}

if (unmuteBtn && videoEl) {
  unmuteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    videoEl.muted = isMuted;
    unmuteBtn.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
  });
  videoEl.muted = true;
}

if (fullscreenBtn && videoEl) {
  fullscreenBtn.addEventListener('click', () => {
    const container = document.getElementById('videoContainer') || videoEl;
    if (!document.fullscreenElement) {
      if (container.requestFullscreen) container.requestFullscreen();
      else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}
