// HOST - RESTARTABLE VERSION
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// GOOGLE STUN
const iceConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ] 
};

// Elements
const getEl = (id) => document.getElementById(id);
const joinBtn = getEl('joinBtn');
const roomInput = getEl('roomInput');
const startCallBtn = getEl('startCallBtn');
const hangupBtn = getEl('hangupBtn');
const localVideo = getEl('localVideo');
const toggleCamBtn = getEl('toggleCamBtn');
const toggleMicBtn = getEl('toggleMicBtn');
const shareScreenBtn = getEl('shareScreenBtn');
const streamLinkInput = getEl('streamLinkInput');
const signalStatusEl = getEl('signalStatus');
// Chat
const chatLog = getEl('chatLog');
const chatInput = getEl('chatInput');
const sendBtn = getEl('sendBtn');
const emojiStrip = getEl('emojiStrip');
const fileInput = getEl('fileInput');
const sendFileBtn = getEl('sendFileBtn');
const fileNameLabel = getEl('fileNameLabel');

// 1. STATUS
socket.on('connect', () => {
    if (signalStatusEl) {
        signalStatusEl.textContent = 'Connected';
        signalStatusEl.classList.add('status-connected');
        signalStatusEl.classList.remove('status-disconnected');
    }
});
socket.on('disconnect', () => {
    if (signalStatusEl) {
        signalStatusEl.textContent = 'Disconnected';
        signalStatusEl.classList.add('status-disconnected');
        signalStatusEl.classList.remove('status-connected');
    }
});

// 2. JOIN
if (joinBtn) {
  joinBtn.addEventListener('click', () => {
    const room = roomInput.value.trim();
    if (!room) return alert("Enter Room Name");
    currentRoom = room;
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    joinBtn.disabled = true;
    const info = getEl('roomInfo');
    if (info) info.textContent = `Room: ${room}`;
    
    const url = new URL(window.location.href);
    url.pathname = '/view.html';
    url.searchParams.set('room', room);
    if (streamLinkInput) streamLinkInput.value = url.toString();
  });
}

// 3. START / RESTART LOGIC (The Fix)
if (startCallBtn) {
  startCallBtn.addEventListener('click', async () => {
    if (!currentRoom) return alert("Join Room First");
    
    // Always get a FRESH stream if we don't have one
    if (!localStream) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
          }
        } catch (err) { return alert("Camera Error: " + err.message); }
    }
    
    // Enable Buttons
    startCallBtn.disabled = true;
    startCallBtn.textContent = "Streaming Active";
    if (hangupBtn) hangupBtn.disabled = false;
    
    // Force Connection
    console.log("Starting Stream...");
    restartConnection();
  });
}

// 4. HANG UP (The Fix)
if (hangupBtn) {
    hangupBtn.addEventListener('click', () => {
        // 1. Kill Connection
        if (pc) { pc.close(); pc = null; }
        
        // 2. Kill Camera (So the light goes off)
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }

        // 3. Reset UI so you can click Start again
        if (localVideo) localVideo.srcObject = null;
        startCallBtn.disabled = false;
        startCallBtn.textContent = 'Start Camera';
        hangupBtn.disabled = true;
        isScreenSharing = false;
        if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
    });
}

// 5. AUTO-CONNECT (Viewer Joins/Rejoins)
socket.on('user-joined', () => {
  if (localStream) {
    console.log("Viewer joined/rejoined. Connecting...");
    restartConnection();
  }
});

async function restartConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };
  
  const stream = isScreenSharing ? screenStream : localStream;
  // Safety check
  if (stream) {
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
  }

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (e) { console.error(e); }
}

// 6. CHAT & FEATURES
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));
if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

if (emojiStrip) {
  emojiStrip.addEventListener('click', e => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('chat-message', { room: currentRoom, name: userName, text });
  appendChat('You', text, Date.now());
  chatInput.value = '';
}
function appendChat(name, text, ts) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const nameHtml = name === 'You' ? `<span style="color:#4af3a3">${name}</span>` : `<strong>${name}</strong>`;
  line.innerHTML = `${nameHtml} <small>${timeString(ts)}</small>: ${text}`;
  if (chatLog) {
      chatLog.appendChild(line);
      chatLog.scrollTop = chatLog.scrollHeight;
  }
}
function timeString(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// File Share
if (fileInput && sendFileBtn) {
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) {
            if (fileNameLabel) fileNameLabel.textContent = fileInput.files[0].name;
            sendFileBtn.disabled = false;
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
                fileSize: file.size,
                fileData: base64
            });
            appendChat('You', `Sent file: ${file.name}`, Date.now());
            fileInput.value = '';
            if (fileNameLabel) fileNameLabel.textContent = 'No file';
            sendFileBtn.disabled = true;
        };
        reader.readAsDataURL(file);
    });
}
socket.on('file-share', ({ from, fileName, fileType, fileSize, fileData }) => {
    const link = `<a href="data:${fileType};base64,${fileData}" download="${fileName}" style="color:#4af3a3">Download ${fileName}</a>`;
    appendChat(from, `Sent a file: ${link}`, Date.now());
});

// Buttons
if (toggleCamBtn) toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return;
  localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled);
});
if (toggleMicBtn) toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled);
});

// Screen Share
if (shareScreenBtn) shareScreenBtn.addEventListener('click', async () => {
    if (!localStream) return alert('Start camera first!');
    if (!isScreenSharing) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            if (pc) {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if (sender) sender.replaceTrack(screenTrack);
            }
            if (localVideo) localVideo.srcObject = screenStream;
            isScreenSharing = true;
            shareScreenBtn.textContent = 'Stop Screen';
            screenTrack.onended = () => stopScreenShare();
        } catch (e) { console.error(e); }
    } else { stopScreenShare(); }
});
function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    if (localStream && pc) {
        const sender = pc.getSenders().find(s => s.track.kind === 'video');
        const camTrack = localStream.getVideoTracks()[0];
        if (sender && camTrack) sender.replaceTrack(camTrack);
        if (localVideo) localVideo.srcObject = localStream;
    }
    isScreenSharing = false;
    if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// Signals
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});
