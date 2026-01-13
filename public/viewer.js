// REBEL STREAM VIEWER
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

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- DOM ---
const viewerVideo   = document.getElementById('viewerVideo');
const viewerStatus  = document.getElementById('viewerStatus');
const headerTitle   = document.getElementById('headerTitle');

const chatPanel     = document.getElementById('chatPanel');
const toggleChatBtn = document.getElementById('toggleChatBtn');
const unmuteBtn     = document.getElementById('unmuteBtn');
const fullBtn       = document.getElementById('fullBtn');

const chatLog       = document.getElementById('chatLog');
const chatInput     = document.getElementById('chatInput');
const sendBtn       = document.getElementById('sendBtn');
const emojiStrip    = document.getElementById('emojiStrip');

// --- STATUS ---
function setStatus(text, isLive = false) {
  if (!viewerStatus) return;
  viewerStatus.textContent = text;
  viewerStatus.classList.toggle('live', isLive);
  viewerStatus.classList.toggle('error', text.toLowerCase().includes('error'));
}

// --- CHAT UI ---
function appendChat(name, text, ts) {
  if (!chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  line.innerHTML = `<strong>${name}</strong> <small>${t}</small>: ${text}`;
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

// LISTEN FOR TITLE UPDATES
socket.on('room-update', ({ streamTitle }) => {
  if (headerTitle) headerTitle.textContent = streamTitle || 'Rebel Stream';
  document.title = streamTitle || 'Rebel Stream';
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

    // 🔥 make sure video actually plays on mobile
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (viewerVideo && viewerVideo.srcObject !== stream) {
        viewerVideo.srcObject = stream;
        viewerVideo.muted = true;
        const playPromise = viewerVideo.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => {
            console.warn('Autoplay blocked, tap video to start:', err);
          });
        }
        setStatus('LIVE', true);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', { room: currentRoom, sdp: answer });
  } catch (e) {
    console.error('Viewer offer error:', e);
    setStatus('Error connecting to stream');
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

// VIEWER CHAT SEND
function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('chat-message', {
    room: currentRoom,
    name: myName,
    text,
    fromViewer: true
  });

  appendChat(myName, text);
  chatInput.value = '';
}

if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});
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

if (fullBtn && viewerVideo) {
  fullBtn.addEventListener('click', () => {
    if (viewerVideo.requestFullscreen) {
      viewerVideo.requestFullscreen();
    } else if (viewerVideo.webkitRequestFullscreen) {
      viewerVideo.webkitRequestFullscreen();
    } else if (viewerVideo.msRequestFullscreen) {
      viewerVideo.msRequestFullscreen();
    }
  });
}

if (toggleChatBtn && chatPanel) {
  let chatVisible = true;
  toggleChatBtn.addEventListener('click', () => {
    chatVisible = !chatVisible;
    chatPanel.style.display = chatVisible ? 'flex' : 'none';
    toggleChatBtn.textContent = chatVisible ? 'Hide Chat' : 'Show Chat';
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
