const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;                 // STREAM PC (host → viewers)
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random() * 1000);

// NEW: separate PC just for the 1-to-1 CALL back to host
let callPc = null;
let localCallStream = null;

// ==========================================
// 1. ARCADE RECEIVER (Game -> Chat Logic)
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
          console.log(`[Arcade] Receiving: ${meta.name}`);
        } catch (e) { }
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
  const log = $('chatLog');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'chat-line system-msg';
  div.innerHTML = `
    <div style="background:rgba(74,243,163,0.1); border:1px solid #4af3a3; padding:10px; border-radius:8px; text-align:center; margin: 10px 0;">
      <div style="color:#4af3a3; font-weight:bold; margin-bottom:5px;">🚀 TOOL RECEIVED: ${name}</div>
      <a href="${url}" download="${name}" style="background:#4af3a3; color:#000; padding:6px 12px; border-radius:4px; display:inline-block; text-decoration:none; font-weight:bold; font-size:0.8rem;">LAUNCH NOW</a>
    </div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ==========================================
// 2. ROOM & STREAM CONNECTION LOGIC
// ==========================================
const params = new URLSearchParams(location.search);
const room = params.get('room');
if (room) {
  currentRoom = room;
  myName = prompt("Enter your display name:") || myName;
  socket.connect();
  // Join specifically as a viewer (so host can see you in Viewers list)
  socket.emit('join-room', { room, name: myName, isViewer: true });
}

socket.on('webrtc-offer', async ({ sdp, from }) => {
  if (pc) pc.close();

  pc = new RTCPeerConnection(iceConfig);
  setupReceiver(pc);

  pc.ontrack = e => {
    const videoEl = $('viewerVideo');
    if (videoEl && videoEl.srcObject !== e.streams[0]) {
      videoEl.srcObject = e.streams[0];
      if ($('viewerStatus')) {
        $('viewerStatus').textContent = "LIVE";
        $('viewerStatus').style.background = "var(--accent)";
      }
    }
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', { targetId: from, candidate: e.candidate });
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.emit('webrtc-answer', { targetId: from, sdp: ans });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc && candidate) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// ==========================================
// 3. CHAT, CALL & UI LOGIC
// ==========================================
//
// 3a) VIEWER ↔ HOST CALL (the “on-stage” call)
// -------------------------------------------

// Host hits “Accept & Call” → server sends ring-alert to this viewer
socket.on('ring-alert', async ({ from, fromId }) => {
  if (!fromId) return;

  const ok = confirm(
    `Host ${from} wants to bring you on stage.\n\nAllow camera & microphone and join the call?`
  );
  if (!ok) return;

  try {
    await ensureLocalCallStream();
    await startCallToHost(fromId);
  } catch (err) {
    console.error('[Viewer] Call setup failed', err);
    alert('Could not access your camera/mic. Check permissions and try again.');
  }
});

// Get local media just for the call (does NOT touch the broadcast stream)
async function ensureLocalCallStream() {
  if (
    localCallStream &&
    localCallStream.getTracks().some(t => t.readyState === 'live')
  ) {
    return;
  }

  localCallStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { width: { ideal: 1280 }, height: { ideal: 720 } }
  });
}

// Start WebRTC P2P call back to the host (same protocol as app.js)
async function startCallToHost(targetId) {
  if (!targetId) return;

  await ensureLocalCallStream();

  // Clean up any previous call
  if (callPc) {
    try { callPc.close(); } catch (e) { }
    callPc = null;
  }

  const pc2 = new RTCPeerConnection(iceConfig);
  callPc = pc2;

  pc2.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('call-ice', {
        targetId,
        candidate: e.candidate
      });
    }
  };

  // We don't need to render the host's call stream here – host already broadcasts.
  // Still hook it so it doesn't crash if remote sends tracks.
  pc2.ontrack = e => {
    console.log('[Viewer] Received call track (host side)', e.streams[0]);
  };

  // Send our cam + mic to host
  localCallStream.getTracks().forEach(t => pc2.addTrack(t, localCallStream));

  const offer = await pc2.createOffer();
  await pc2.setLocalDescription(offer);

  socket.emit('call-offer', {
    targetId,
    offer
  });
}

// Host answers our call
socket.on('call-answer', async ({ from, answer }) => {
  if (!callPc || !answer) return;
  try {
    await callPc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (e) {
    console.error('[Viewer] Failed to set remote answer', e);
  }
});

// ICE for the 1-to-1 call
socket.on('call-ice', ({ from, candidate }) => {
  if (!callPc || !candidate) return;
  try {
    callPc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('[Viewer] Failed to add ICE candidate', e);
  }
});

// Call ended by host
socket.on('call-end', ({ from }) => {
  if (callPc) {
    try { callPc.close(); } catch (e) { }
    callPc = null;
  }
});

// -------------------------------------------
// 3b) PUBLIC CHAT
// -------------------------------------------
socket.on('public-chat', d => {
  const log = $('chatLog');
  if (!log) return;

  const div = document.createElement('div');
  div.className = 'chat-line';

  const name = document.createElement('strong');
  name.textContent = d.name;

  const msg = document.createElement('span');
  msg.textContent = `: ${d.text}`;

  div.appendChild(name);
  div.appendChild(msg);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;

  const mirror = $('viewerStatusMirror');
  if (mirror) {
    mirror.textContent = `${d.name}`;
  }
});

socket.on('kicked', () => {
  alert("You have been kicked from the room by the host.");
  window.location.href = "index.html";
});

socket.on('room-error', (err) => {
  alert(err);
  window.location.href = "index.html";
});

// Chat Input
if ($('sendBtn')) {
  $('sendBtn').onclick = () => {
    const inp = $('chatInput');
    if (!inp || !inp.value.trim()) return;
    socket.emit('public-chat', {
      room: currentRoom,
      text: inp.value,
      name: myName,
      fromViewer: true
    });
    inp.value = '';
  };
}

if ($('chatInput')) {
  $('chatInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('sendBtn').onclick();
  };
}

// Hand Raise Button logic
if ($('requestCallBtn')) {
  $('requestCallBtn').onclick = () => {
    socket.emit('request-to-call');
    $('requestCallBtn').textContent = "Request Sent ✋";
    $('requestCallBtn').disabled = true;
  };
}

if ($('emojiStrip')) {
  $('emojiStrip').onclick = (e) => {
    if (e.target.classList.contains('emoji')) {
      $('chatInput').value += e.target.textContent;
    }
  };
}

// UI Controls
if ($('unmuteBtn')) {
  $('unmuteBtn').onclick = () => {
    const v = $('viewerVideo');
    if (!v) return;
    v.muted = !v.muted;
    $('unmuteBtn').textContent = v.muted ? "🔇 Unmute" : "🔊 Muted";
  };
}

if ($('fullscreenBtn')) {
  $('fullscreenBtn').onclick = () => {
    const v = $('viewerVideo');
    if (!v) return;
    if (v.requestFullscreen) v.requestFullscreen();
    else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
    else if (v.msRequestFullscreen) v.msRequestFullscreen();
  };
}

if ($('toggleChatBtn')) {
  $('toggleChatBtn').onclick = () => {
    const box = $('chatBox');
    if (!box) return;
    box.classList.toggle('hidden');
  };
}
