// Rebel Host – Calls + Separate Stream + Chat + Files

const socket = io({ autoConnect: false });

// Rooms
let currentRoom = null;      // main chat / call room
let streamRoom = null;       // separate random stream room for viewers

// Identity
let userName = 'Host';

// WebRTC
let callPc = null;           // 2-way call peer connection
let streamPc = null;         // 1-way stream peer connection
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// ICE config (can be overridden by config/ice.js via ICE_SERVERS)
const iceConfig = typeof ICE_SERVERS !== 'undefined'
  ? { iceServers: ICE_SERVERS }
  : {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

// DOM helper
const $ = (id) => document.getElementById(id);

// Elements
const joinBtn        = $('joinBtn');
const leaveBtn       = $('leaveBtn');
const roomInput      = $('roomInput');
const nameInput      = $('nameInput');
const roomInfo       = $('roomInfo');
const signalStatusEl = $('signalStatus');

const localVideo     = $('localVideo');
const remoteVideo    = $('remoteVideo');
const startCallBtn   = $('startCallBtn');
const hangupBtn      = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn   = $('toggleCamBtn');
const toggleMicBtn   = $('toggleMicBtn');

const streamLinkInput = $('streamLinkInput');
const openStreamBtn   = $('openStreamBtn');

const chatLog       = $('chatLog');
const chatInput     = $('chatInput');
const sendBtn       = $('sendBtn');
const emojiStrip    = $('emojiStrip');
const fileInput     = $('fileInput');
const sendFileBtn   = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');

// ---------------- Socket status ----------------
socket.on('connect', () => {
  if (signalStatusEl) {
    signalStatusEl.textContent = 'Connected';
    signalStatusEl.classList.remove('status-disconnected');
    signalStatusEl.classList.add('status-connected');
  }
});

socket.on('disconnect', () => {
  if (signalStatusEl) {
    signalStatusEl.textContent = 'Disconnected';
    signalStatusEl.classList.remove('status-connected');
    signalStatusEl.classList.add('status-disconnected');
  }
});

// ---------------- Join / Leave ----------------
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = (roomInput.value || '').trim();
    if (!room) {
      alert('Enter room code');
      return;
    }

    currentRoom = room;
    const rawName = (nameInput.value || '').trim();
    userName = rawName || 'Host';

    socket.connect();
    socket.emit('join-room', { room: currentRoom, name: userName });

    joinBtn.disabled = true;
    leaveBtn.disabled = false;

    if (roomInfo) roomInfo.textContent = `Room: ${currentRoom}`;

    // Also prep a default viewer link pointing at the main room
    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.search = `room=${encodeURIComponent(currentRoom)}`;
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    if (currentRoom) socket.emit('leave-room', { room: currentRoom });
    if (streamRoom)  socket.emit('leave-room', { room: streamRoom });

    cleanupAll();

    currentRoom = null;
    streamRoom  = null;

    if (roomInfo) roomInfo.textContent = 'No room';
    if (streamLinkInput) streamLinkInput.value = '';

    joinBtn.disabled  = false;
    leaveBtn.disabled = true;
  });
}

function cleanupAll() {
  // Close peer connections
  if (callPc)   { callPc.close();   callPc   = null; }
  if (streamPc) { streamPc.close(); streamPc = null; }

  // Stop media
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  if (localVideo)  localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;

  isScreenSharing = false;
  if (shareScreenBtn)   shareScreenBtn.textContent = 'Share Screen';
  if (startCallBtn) {
    startCallBtn.disabled = false;
    startCallBtn.textContent = 'Start Call';
  }
  if (hangupBtn) {
    hangupBtn.disabled = true;
  }
}

// ---------------- Media helpers ----------------
async function ensureLocalStream() {
  if (localStream) return;

  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
  }
}

// ---------------- Calls (2-way in currentRoom) ----------------
if (startCallBtn) {
  startCallBtn.addEventListener('click', async () => {
    if (!currentRoom) {
      alert('Join a room first');
      return;
    }

    try {
      await ensureLocalStream();
    } catch (err) {
      alert('Camera / mic error: ' + err.message);
      return;
    }

    await startCallAsCaller();
  });
}

if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    if (callPc) {
      callPc.close();
      callPc = null;
    }
    if (remoteVideo) remoteVideo.srcObject = null;

    if (startCallBtn) {
      startCallBtn.disabled = false;
      startCallBtn.textContent = 'Start Call';
    }
    hangupBtn.disabled = true;
  });
}

async function startCallAsCaller() {
  if (callPc) callPc.close();
  callPc = new RTCPeerConnection(iceConfig);

  if (localStream) {
    localStream.getTracks().forEach(t => callPc.addTrack(t, localStream));
  }

  callPc.ontrack = (e) => {
    if (remoteVideo) remoteVideo.srcObject = e.streams[0];
  };

  callPc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  const offer = await callPc.createOffer();
  await callPc.setLocalDescription(offer);

  socket.emit('webrtc-offer', {
    room: currentRoom,
    sdp: callPc.localDescription
  });

  startCallBtn.disabled = true;
  startCallBtn.textContent = 'Call Active';
  hangupBtn.disabled = false;
}

// Incoming offer (other side started call)
socket.on('webrtc-offer', async ({ room, sdp }) => {
  if (!room || room !== currentRoom) return;

  try {
    await ensureLocalStream();
  } catch (err) {
    console.error('Media error answering call', err);
    return;
  }

  if (callPc) callPc.close();
  callPc = new RTCPeerConnection(iceConfig);

  if (localStream) {
    localStream.getTracks().forEach(t => callPc.addTrack(t, localStream));
  }

  callPc.ontrack = (e) => {
    if (remoteVideo) remoteVideo.srcObject = e.streams[0];
  };

  callPc.onicecandidate = (e) => {
    if (e.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: e.candidate
      });
    }
  };

  await callPc.setRemoteDescription(new RTCSessionDescription(sdp));

  const answer = await callPc.createAnswer();
  await callPc.setLocalDescription(answer);

  socket.emit('webrtc-answer', {
    room: currentRoom,
    sdp: callPc.localDescription
  });

  if (startCallBtn) {
    startCallBtn.disabled = true;
    startCallBtn.textContent = 'Call Active';
  }
  if (hangupBtn) hangupBtn.disabled = false;
});

// Answer from remote (when we were caller)
socket.on('webrtc-answer', async ({ room, sdp }) => {
  if (!room || room !== currentRoom) return;
  if (!callPc) return;
  await callPc.setRemoteDescription(new RTCSessionDescription(sdp));
});

// ---------------- Stream (1-way to view.html) ----------------
//
// Host still joins main room normally.
// When you hit Share Screen, we also:
//   - create a random stream room (stream-XXXXXX)
//   - join it
//   - start a stream-only RTCPeerConnection to that room
//   - update the Stream Link box.

if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!currentRoom) {
      alert('Join your main room first');
      return;
    }

    if (!isScreenSharing) {
      try {
        await ensureLocalStream();
      } catch (err) {
        alert('Camera / mic error: ' + err.message);
        return;
      }

      // create stream room first time
      if (!streamRoom) {
        const rand = Math.floor(100000 + Math.random() * 900000);
        streamRoom = `stream-${rand}`;
        socket.emit('join-room', {
          room: streamRoom,
          name: `${userName}-stream`
        });

        const url = new URL(window.location.href);
        url.pathname = '/view.html';
        url.search = `room=${encodeURIComponent(streamRoom)}`;
        if (streamLinkInput) streamLinkInput.value = url.toString();
      }

      await startStreamConnection();

      // switch to screen
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        if (streamPc) {
          const sender = streamPc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        }

        // local preview: screen + mic
        const mixed = new MediaStream([
          screenTrack,
          ...localStream.getAudioTracks()
        ]);
        if (localVideo) localVideo.srcObject = mixed;

        screenTrack.onended = () => stopScreenShare();

        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';
      } catch (err) {
        console.error('Screen share error', err);
      }
    } else {
      stopScreenShare();
    }
  });
}

async function startStreamConnection() {
  if (!streamRoom) return;

  if (streamPc) streamPc.close();
  streamPc = new RTCPeerConnection(iceConfig);

  if (localStream) {
    localStream.getTracks().forEach(t => streamPc.addTrack(t, localStream));
  }

  streamPc.onicecandidate = (e) => {
    if (e.candidate && streamRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: streamRoom,
        candidate: e.candidate
      });
    }
  };

  const offer = await streamPc.createOffer();
  await streamPc.setLocalDescription(offer);

  socket.emit('webrtc-offer', {
    room: streamRoom,
    sdp: streamPc.localDescription
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;

  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  // go back to camera in streamPc
  const camTrack = localStream && localStream.getVideoTracks
    ? localStream.getVideoTracks()[0]
    : null;

  if (camTrack && streamPc) {
    const sender = streamPc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(camTrack);
  }

  if (localVideo && localStream) localVideo.srcObject = localStream;

  isScreenSharing = false;
  if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// Stream ICE handling
socket.on('webrtc-ice-candidate', async ({ room, candidate }) => {
  if (!candidate) return;

  const ice = new RTCIceCandidate(candidate);

  if (room === currentRoom && callPc) {
    try {
      await callPc.addIceCandidate(ice);
    } catch (err) {
      console.error('callPc addIceCandidate error', err);
    }
  } else if (room === streamRoom && streamPc) {
    try {
      await streamPc.addIceCandidate(ice);
    } catch (err) {
      console.error('streamPc addIceCandidate error', err);
    }
  }
});

// ---------------- Cam / Mic toggles ----------------
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    toggleCamBtn.textContent = track.enabled ? 'Camera Off' : 'Camera On';
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    toggleMicBtn.textContent = track.enabled ? 'Mute' : 'Unmute';
  });
}

// ---------------- Chat ----------------
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
  if (!text || !currentRoom) return;

  const ts = Date.now();

  socket.emit('chat-message', {
    room: currentRoom,
    name: userName,
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
  appendChat(name || 'Peer', text, ts);
});

// ---------------- Files ----------------
if (fileInput && sendFileBtn) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) {
      if (fileNameLabel) fileNameLabel.textContent = fileInput.files[0].name;
      sendFileBtn.disabled = false;
    } else {
      if (fileNameLabel) fileNameLabel.textContent = 'No file';
      sendFileBtn.disabled = true;
    }
  });

  sendFileBtn.addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file || !currentRoom) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];

      socket.emit('file-share', {
        room: currentRoom,
        name: userName,
        fileName: file.name,
        fileType: file.type,
        data: base64
      });

      const a = document.createElement('a');
      a.href = `data:${file.type};base64,${base64}`;
      a.download = file.name;
      a.textContent = `You sent: ${file.name}`;

      const line = document.createElement('div');
      line.className = 'chat-line system';
      line.appendChild(a);
      chatLog.appendChild(line);
      chatLog.scrollTop = chatLog.scrollHeight;

      fileInput.value = '';
      sendFileBtn.disabled = true;
      if (fileNameLabel) fileNameLabel.textContent = 'No file';
    };
    reader.readAsDataURL(file);
  });
}

socket.on('file-share', ({ name, fileName, fileType, data }) => {
  const link = document.createElement('a');
  link.href = `data:${fileType};base64,${data}`;
  link.download = fileName;
  link.textContent = `${name || 'Peer'} sent: ${fileName}`;

  const line = document.createElement('div');
  line.className = 'chat-line system';
  line.appendChild(link);

  if (chatLog) {
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
});
