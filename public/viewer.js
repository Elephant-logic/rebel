// REBEL STREAM - VIEWER CLIENT (POLISHED, NO SIGNUP)
const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random() * 1000);

// === UI REFS ===
const viewerVideo        = $('viewerVideo');
const chatBox            = $('chatBox');
const chatLogEl          = $('chatLog');
const chatInput          = $('chatInput');
const sendBtn            = $('sendBtn');
const emojiStrip         = $('emojiStrip');
const toggleChatBtn      = $('toggleChatBtn');
const unmuteBtn          = $('unmuteBtn');
const fullscreenBtn      = $('fullscreenBtn');
const viewerStatus       = $('viewerStatus');
const viewerStatusMirror = $('viewerStatusMirror');
const viewerCountEl      = $('viewerCount');

let chatOpen = true;
let hasStream = false;
let viewerMuted = true;

// ==========================
// STATUS HELPERS
// ==========================
function setStatus(text) {
  if (viewerStatus) viewerStatus.textContent = text;
  if (viewerStatusMirror) viewerStatusMirror.textContent = text;
}

function setLiveStatus() {
  setStatus('LIVE');
}

function setWaitingStatus() {
  setStatus('Connected — waiting for stream');
}

// ==========================
// CHAT HELPERS
// ==========================
function appendChatLine(html, extraClass = '') {
  if (!chatLogEl) return;
  const div = document.createElement('div');
  div.className = `chat-line ${extraClass}`.trim();
  div.innerHTML = html;
  chatLogEl.appendChild(div);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function addSystemMessage(msg) {
  appendChatLine(`<span style="opacity:0.8;">${msg}</span>`, 'system-msg');
}

// ==========================================
// ARCADE RECEIVER (Game -> Chat Logic)
// ==========================================
function setupReceiver(pc) {
  pc.ondatachannel = (e) => {
    if (e.channel.label !== "side-load-pipe") return;
    const chan = e.channel;
    let chunks = [], total = 0, curr = 0, meta = null;

    chan.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        try {
          meta = JSON.parse(evt.data);
          total = meta.size;
        } catch (_) {}
      } else {
        chunks.push(evt.data);
        curr += evt.data.byteLength;
        if (curr >= total) {
          const blob = new Blob(chunks, { type: meta ? meta.mime : 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          addGameToChat(url, meta ? meta.name : 'Tool');
          chan.close();
        }
      }
    };
  };
}

function addGameToChat(url, name) {
  // Make sure chat is visible when a tool arrives
  if (chatBox && chatBox.classList.contains('hidden')) {
    chatBox.classList.remove('hidden');
    chatOpen = true;
    if (toggleChatBtn) toggleChatBtn.textContent = 'Chat';
  }

  const html = `
    <div style="background:rgba(74,243,163,0.1);
                border:1px solid #4af3a3;
                padding:10px;
                border-radius:8px;
                text-align:center;">
      <div style="color:#4af3a3;font-weight:bold;">
        🚀 TOOL RECEIVED: ${name}
      </div>
      <a href="${url}" download="${name}"
         style="background:#4af3a3;color:#000;padding:6px;
                border-radius:4px;display:inline-block;
                margin-top:5px;text-decoration:none;
                font-weight:bold;">
        LAUNCH NOW
      </a>
    </div>
  `;
  appendChatLine(html, 'system-msg');
}

// ==========================
// ROOM BOOTSTRAP
// ==========================
const params = new URLSearchParams(location.search);
const room = params.get('room');

if (room) {
  currentRoom = room;
  myName = prompt("Name?") || myName;

  setStatus('CONNECTING...');
  socket.connect();
  socket.emit('join-room', { room, name: myName });
} else {
  // No room in URL – just show a friendly hint
  setStatus('No stream code in link');
  addSystemMessage('No stream attached to this link.');
}

// Socket connection status
socket.on('connect', () => {
  if (currentRoom) {
    setWaitingStatus();
    addSystemMessage(`Connected to room: <strong>${currentRoom}</strong>`);
  }
});

socket.on('disconnect', () => {
  setStatus('DISCONNECTED');
  if (viewerCountEl) viewerCountEl.textContent = '';
  addSystemMessage('Connection lost.');
});

socket.on('connect_error', (err) => {
  console.error('Viewer connect_error', err);
  setStatus('Connection error');
  addSystemMessage('Could not connect to the stream.');
});

// ==========================
// WEBRTC HANDSHAKE
// ==========================
socket.on('webrtc-offer', async ({ sdp, from }) => {
  // Kill old connection if host migrated so the new stream takes over instantly
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);
  setupReceiver(pc);

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (viewerVideo && viewerVideo.srcObject !== stream) {
      viewerVideo.srcObject = stream;
      hasStream = true;
      // When the video actually starts playing, mark LIVE
      viewerVideo.onplaying = () => {
        setLiveStatus();
      };
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', { targetId: from, candidate: e.candidate });
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.emit('webrtc-answer', { targetId: from, sdp: ans });

  if (!hasStream) {
    setWaitingStatus();
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('Failed to add ICE candidate on viewer:', err);
    }
  }
});

// ==========================
// PUBLIC CHAT (Q&A)
// ==========================
socket.on('public-chat', d => {
  const safeText = ('' + d.text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeName = ('' + d.name).replace(/</g, "&lt;").replace(/>/g, "&gt;");

  appendChatLine(`<strong>${safeName}</strong>: <span>${safeText}</span>`);

  // If chat is hidden and a message arrives, hint with border
  if (!chatOpen && toggleChatBtn) {
    toggleChatBtn.style.borderColor = '#4af3a3';
  }
});

// ==========================
// VIEWER COUNT (from room-update)
// ==========================
socket.on('room-update', ({ users, ownerId }) => {
  if (!viewerCountEl || !Array.isArray(users)) return;

  // Count all users except the host
  const total = users.length;
  const viewers = Math.max(total - 1, 0);

  if (viewers > 0) {
    viewerCountEl.textContent = `${viewers} watching`;
  } else {
    viewerCountEl.textContent = '';
  }
});

// Send chat
if (sendBtn && chatInput) {
  const sendMessage = () => {
    const txt = chatInput.value.trim();
    if (!txt || !currentRoom) return;
    socket.emit('public-chat', {
      room: currentRoom,
      text: txt,
      name: myName,
      fromViewer: true
    });
    chatInput.value = '';
  };

  sendBtn.onclick = sendMessage;
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });
}

// Emoji strip
if (emojiStrip && chatInput) {
  emojiStrip.querySelectorAll('.emoji').forEach(span => {
    span.addEventListener('click', () => {
      chatInput.value += span.textContent;
      chatInput.focus();
    });
  });
}

// ==========================
// VIEWER CONTROLS
// ==========================

// Toggle chat overlay
if (toggleChatBtn && chatBox) {
  toggleChatBtn.addEventListener('click', () => {
    chatOpen = !chatOpen;
    if (chatOpen) {
      chatBox.classList.remove('hidden');
      toggleChatBtn.textContent = 'Chat';
      toggleChatBtn.style.borderColor = '';
    } else {
      chatBox.classList.add('hidden');
      toggleChatBtn.textContent = 'Chat Off';
    }
  });
}

// Unmute / mute audio
if (unmuteBtn && viewerVideo) {
  viewerVideo.muted = true;
  viewerVideo.volume = 1.0;

  unmuteBtn.addEventListener('click', () => {
    viewerMuted = !viewerMuted;
    viewerVideo.muted = viewerMuted;
    unmuteBtn.textContent = viewerMuted ? '🔇 Unmute' : '🔊 Live';
  });
}

// Fullscreen toggle
if (fullscreenBtn && viewerVideo) {
  fullscreenBtn.addEventListener('click', () => {
    const el = viewerVideo;
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  });
}
