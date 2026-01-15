// public/viewer.js

// Simple DOM helper
const $ = id => document.getElementById(id);

// Socket & ICE config (uses config/ice.js if present)
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = 'Viewer-' + Math.floor(Math.random() * 1000);

// ==========================================
// STATUS + VIEWER COUNT
// ==========================================
let isLive = false;
let viewerCount = 0;

function setStatus(text) {
  if ($('viewerStatus')) $('viewerStatus').textContent = text;
  if ($('viewerStatusMirror')) $('viewerStatusMirror').textContent = text;
}

function setStatusDisconnected() {
  isLive = false;
  setStatus('DISCONNECTED');
}

function setStatusWaiting() {
  if (!isLive) setStatus('Connected - waiting for host');
}

function setStatusLive() {
  isLive = true;
  if (viewerCount > 0) {
    setStatus('LIVE • ' + viewerCount + ' watching');
  } else {
    setStatus('LIVE');
  }
}

// ==========================================
// ARCADE RECEIVER (P2P tool/file from host)
// ==========================================
function setupReceiver(pc) {
  pc.ondatachannel = (e) => {
    if (e.channel.label !== 'side-load-pipe') return;

    const chan = e.channel;
    let chunks = [];
    let total = 0;
    let curr = 0;
    let meta = null;

    chan.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        // metadata: { type:'meta', name, size, mime }
        try {
          meta = JSON.parse(evt.data);
          total = meta.size || 0;
        } catch (err) {
          console.warn('Arcade meta parse error', err);
        }
      } else {
        chunks.push(evt.data);
        curr += evt.data.byteLength;

        if (total && curr >= total) {
          const blob = new Blob(chunks, {
            type: meta && meta.mime ? meta.mime : 'application/octet-stream'
          });
          const url = URL.createObjectURL(blob);
          addGameToChat(url, meta && meta.name ? meta.name : 'Tool');
          chan.close();
        }
      }
    };
  };
}

function addGameToChat(url, name) {
  const log = $('chatLog');
  const div = document.createElement('div');
  div.className = 'chat-line system-msg';
  div.innerHTML = `
    <div style="background:rgba(74,243,163,0.1);border:1px solid #4af3a3;padding:10px;border-radius:8px;text-align:center;">
      <div style="color:#4af3a3;font-weight:bold;">🚀 TOOL RECEIVED: ${name}</div>
      <a href="${url}" download="${name}"
         style="background:#4af3a3;color:#000;padding:6px;border-radius:4px;display:inline-block;margin-top:5px;text-decoration:none;font-weight:bold;">
        LAUNCH NOW
      </a>
    </div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ==========================================
// JOIN ROOM FROM ?room=xyz
// ==========================================
const params = new URLSearchParams(location.search);
const room = params.get('room');

if (room) {
  currentRoom = room;
  const namePrompt = prompt('Name?');
  if (namePrompt && namePrompt.trim()) {
    myName = namePrompt.trim();
  }

  socket.connect();
  socket.emit('join-room', { room, name: myName });
  setStatus('Connecting...');
} else {
  setStatus('No room');
}

// ==========================================
// SOCKET EVENTS (status + room info)
// ==========================================
socket.on('connect', () => {
  setStatusWaiting();
});

socket.on('disconnect', () => {
  setStatusDisconnected();
});

// Get viewer count + title from server
socket.on('room-update', ({ users, streamTitle }) => {
  const total = Array.isArray(users) ? users.length : 0;
  viewerCount = Math.max(total - 1, 0); // assume 1 host

  if (isLive) {
    setStatusLive();
  } else {
    if (viewerCount > 0) {
      setStatus('Waiting • ' + viewerCount + ' in room');
    } else {
      setStatusWaiting();
    }
  }

  if (streamTitle) {
    document.title = streamTitle + ' — Rebel Stream';
  }
});

// ==========================================
// WEBRTC OFFER / ANSWER / ICE
// ==========================================
socket.on('webrtc-offer', async ({ sdp, from }) => {
  try {
    // Kill any existing connection so a migrated host takes over cleanly
    if (pc) pc.close();

    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);

    pc.ontrack = (e) => {
      const videoEl = $('viewerVideo');
      if (videoEl && videoEl.srcObject !== e.streams[0]) {
        videoEl.srcObject = e.streams[0];
      }
      setStatusLive();
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('webrtc-ice-candidate', {
          targetId: from,
          candidate: e.candidate
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('webrtc-answer', { targetId: from, sdp: ans });
  } catch (err) {
    console.error('Viewer webrtc-offer error', err);
    setStatus('Error – refresh page');
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  try {
    if (pc && candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.warn('Viewer ICE err', err);
  }
});

// ==========================================
// PUBLIC CHAT (STREAM CHAT)
// ==========================================
socket.on('public-chat', (d) => {
  const div = document.createElement('div');
  div.className = 'chat-line';
  div.innerHTML = `<strong>${d.name}</strong>: <span>${d.text}</span>`;
  $('chatLog').appendChild(div);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
});

$('sendBtn').onclick = () => {
  const input = $('chatInput');
  if (!input || !input.value.trim()) return;
  socket.emit('public-chat', {
    room: currentRoom,
    text: input.value,
    name: myName,
    fromViewer: true
  });
  input.value = '';
};

// Enter to send
if ($('chatInput')) {
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if ($('sendBtn')) $('sendBtn').click();
    }
  });
}

// ==========================================
// VIEWER UI CONTROLS (chat / mute / fullscreen / emoji)
// ==========================================

// Toggle chat overlay
if ($('toggleChatBtn')) {
  $('toggleChatBtn').onclick = () => {
    const box = $('chatBox');
    if (!box) return;
    box.classList.toggle('hidden'); // .chat-overlay.hidden already styled in view.html
  };
}

// Mute / unmute
if ($('unmuteBtn')) {
  $('unmuteBtn').onclick = () => {
    const video = $('viewerVideo');
    if (!video) return;
    if (video.muted) {
      video.muted = false;
      video.volume = 1.0;
      $('unmuteBtn').textContent = 'Mute';
    } else {
      video.muted = true;
      $('unmuteBtn').textContent = 'Unmute';
    }
  };
}

// Fullscreen toggle
if ($('fullscreenBtn')) {
  $('fullscreenBtn').onclick = async () => {
    const shell = document.querySelector('.viewer-shell') || $('viewerVideo') || document.body;
    try {
      if (!document.fullscreenElement) {
        if (shell.requestFullscreen) {
          await shell.requestFullscreen();
        } else if (shell.webkitRequestFullscreen) {
          shell.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    } catch (e) {
      console.warn('Fullscreen error', e);
    }
  };
}

// Emoji strip → append emoji into chat box
(function initEmojis() {
  const strip = $('emojiStrip');
  const input = $('chatInput');
  if (!strip || !input) return;

  strip.querySelectorAll('.emoji').forEach((el) => {
    el.addEventListener('click', () => {
      input.value = (input.value || '') + el.textContent;
      input.focus();
    });
  });
})();
