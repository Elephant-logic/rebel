// ==================================================================
// REBEL MESSENGER - FULL CLIENT APPLICATION
// ==================================================================
const socket = io({ autoConnect: false });

// --- GLOBAL STATE ---
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// MEDIA STATE
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let currentAudioDeviceId = undefined;
let currentVideoDeviceId = undefined;

// P2P CALLING STATE (Mesh Network)
// callPeers[socketId] = { pc: RTCPeerConnection, name: string, iceQueue: [] }
const callPeers = {}; 

// STREAMING STATE (Host -> Viewer)
let pc = null; 
let isStreaming = false;
let broadcastStream = null;

// CONFIG
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- DOM ELEMENTS (Cached) ---
const $ = id => document.getElementById(id);

// Connection Inputs
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const signalStatus = $('signalStatus');
const roomInfo = $('roomInfo');

// Host Controls
const hostControls = $('hostControls');
const lockRoomBtn = $('lockRoomBtn');
const streamTitleInput = $('streamTitleInput');
const updateTitleBtn = $('updateTitleBtn');
const slugInput = $('slugInput');
const updateSlugBtn = $('updateSlugBtn');

// Media & Grid
const videoGrid = $('videoGrid');
const localVideo = $('localVideo');
const startStreamBtn = $('startStreamBtn');
const streamQuality = $('streamQuality'); 
const hangupBtn = $('hangupBtn'); 
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const settingsBtn = $('settingsBtn');
const streamLinkInput = $('streamLinkInput');
const openStreamBtn = $('openStreamBtn');

// Settings Panel
const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const videoSource = $('videoSource');
const closeSettingsBtn = $('closeSettingsBtn');

// Tabs & Content
const tabChatBtn = $('tabChatBtn');
const tabFilesBtn = $('tabFilesBtn');
const tabUsersBtn = $('tabUsersBtn');
const tabContentChat = $('tabContentChat');
const tabContentFiles = $('tabContentFiles');
const tabContentUsers = $('tabContentUsers');

// Chat
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const emojiStrip = $('emojiStrip');

// Files
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileLog = $('fileLog');
const fileNameLabel = $('fileNameLabel');

// Users
const userList = $('userList');


// ==================================================================
// 1. INITIALIZATION & TABS
// ==================================================================

function switchTab(tabName) {
  // Reset all
  [tabChatBtn, tabFilesBtn, tabUsersBtn].forEach(b => b && b.classList.remove('active'));
  [tabContentChat, tabContentFiles, tabContentUsers].forEach(c => c && c.classList.remove('active'));

  // Activate specific
  if (tabName === 'chat') {
    if (tabChatBtn) tabChatBtn.classList.add('active');
    if (tabContentChat) tabContentChat.classList.add('active');
  } else if (tabName === 'files') {
    if (tabFilesBtn) tabFilesBtn.classList.add('active');
    if (tabContentFiles) tabContentFiles.classList.add('active');
  } else if (tabName === 'users') {
    if (tabUsersBtn) tabUsersBtn.classList.add('active');
    if (tabContentUsers) tabContentUsers.classList.add('active');
  }
}

if (tabChatBtn) tabChatBtn.addEventListener('click', () => switchTab('chat'));
if (tabFilesBtn) tabFilesBtn.addEventListener('click', () => switchTab('files'));
if (tabUsersBtn) tabUsersBtn.addEventListener('click', () => switchTab('users'));


// ==================================================================
// 2. DEVICE MANAGEMENT & MEDIA
// ==================================================================

// Fetch list of cameras/mics
async function getDevices() {
  try {
    // Request permission first to get labels
    await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audios = devices.filter(d => d.kind === 'audioinput');
    const videos = devices.filter(d => d.kind === 'videoinput');
    
    if (audioSource) {
      const current = audioSource.value;
      audioSource.innerHTML = audios.map(d => `<option value="${d.deviceId}">${d.label || 'Microphone ' + d.deviceId.slice(0,4)}</option>`).join('');
      if (current) audioSource.value = current;
    }
    
    if (videoSource) {
      const current = videoSource.value;
      videoSource.innerHTML = videos.map(d => `<option value="${d.deviceId}">${d.label || 'Camera ' + d.deviceId.slice(0,4)}</option>`).join('');
      if (current) videoSource.value = current;
    }
  } catch(e) { 
    console.error("Error enumerating devices:", e);
  }
}

// Switch Media (Hot-Swap)
async function switchMedia() {
  // 1. Determine constraints based on dropdowns
  const aId = audioSource ? audioSource.value : undefined;
  const vId = videoSource ? videoSource.value : undefined;

  currentAudioDeviceId = aId;
  currentVideoDeviceId = vId;

  const constraints = {
    audio: aId ? { deviceId: { exact: aId } } : true,
    video: vId ? { deviceId: { exact: vId } } : true
  };

  // 2. Stop old tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }

  try {
    // 3. Get new stream
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.muted = true; // Always mute local self
    }

    // 4. Update ALL active connections (Host Stream + P2P Calls)
    const newVideoTrack = localStream.getVideoTracks()[0];
    const newAudioTrack = localStream.getAudioTracks()[0];

    // Helper to replace track in a PC
    const replaceTrackInPC = (peerConnection) => {
      if (!peerConnection) return;
      const senders = peerConnection.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      
      if (videoSender && newVideoTrack) videoSender.replaceTrack(newVideoTrack).catch(e => console.log('Replace Vid Error', e));
      if (audioSender && newAudioTrack) audioSender.replaceTrack(newAudioTrack).catch(e => console.log('Replace Aud Error', e));
    };

    // Update Stream
    if (isStreaming && pc && !isScreenSharing) {
      replaceTrackInPC(pc);
    }

    // Update Calls
    Object.values(callPeers).forEach(peer => {
      replaceTrackInPC(peer.pc);
    });

  } catch(e) {
    console.error("Switch Media Failed", e);
    alert("Could not switch device. Permission denied or device in use.");
  }
}

// Initial Media Setup
async function ensureLocalStream() {
  if (localStream && localStream.active) return localStream;
  await switchMedia();
  if (!localStream) {
    // Fallback if switchMedia failed due to constraints
    try {
       localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
       localVideo.srcObject = localStream;
    } catch(e) {
       console.error("Critical Media Failure", e);
       alert("No Camera/Mic found.");
    }
  }
  return localStream;
}

// UI Listeners for Settings
if (settingsBtn) settingsBtn.addEventListener('click', async () => {
  if (settingsPanel.style.display === 'none') {
    settingsPanel.style.display = 'block';
    await getDevices();
  } else {
    settingsPanel.style.display = 'none';
  }
});

if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => {
  settingsPanel.style.display = 'none';
  // Apply changes when closing
  switchMedia();
});

if (audioSource) audioSource.addEventListener('change', () => switchMedia());
if (videoSource) videoSource.addEventListener('change', () => switchMedia());


// ==================================================================
// 3. CONNECTION & ROOM LOGIC
// ==================================================================

if (joinBtn) joinBtn.addEventListener('click', () => {
  const r = roomInput.value.trim();
  const n = nameInput.value.trim();
  
  if (!r) return alert("Please enter a Room ID");

  currentRoom = r;
  userName = n || 'Anonymous';

  socket.connect();
  socket.emit('join-room', { room: currentRoom, name: userName });

  joinBtn.disabled = true;
  if (leaveBtn) leaveBtn.disabled = false;
  roomInfo.textContent = `Room: ${r}`;

  // Start media immediately
  ensureLocalStream();
});

if (leaveBtn) leaveBtn.addEventListener('click', () => {
  window.location.reload();
});

socket.on('connect', () => {
  myId = socket.id;
  if (signalStatus) {
    signalStatus.textContent = "Connected";
    signalStatus.className = "status-dot status-connected";
  }
});

socket.on('disconnect', () => {
  if (signalStatus) {
    signalStatus.textContent = "Disconnected";
    signalStatus.className = "status-dot status-disconnected";
  }
});

socket.on('room-error', (msg) => {
  alert(msg);
  joinBtn.disabled = false;
  if (leaveBtn) leaveBtn.disabled = true;
});


// ==================================================================
// 4. CALLING LOGIC (MESH NETWORK)
// ==================================================================

// Add Video to Grid
function addRemoteVideo(id, stream, name) {
  const existing = document.getElementById(`vid-${id}`);
  if (existing) {
    existing.querySelector('video').srcObject = stream;
    return;
  }
  
  const div = document.createElement('div');
  div.className = 'video-container';
  div.id = `vid-${id}`;
  div.innerHTML = `
    <h2>${name}</h2>
    <video autoplay playsinline></video>
  `;
  div.querySelector('video').srcObject = stream;
  videoGrid.appendChild(div);
}

// Remove Video
function removeRemoteVideo(id) {
  const div = document.getElementById(`vid-${id}`);
  if (div) div.remove();
}

function createPeerConnection(targetId, targetName) {
  const cp = new RTCPeerConnection(iceConfig);
  
  // Create object to track peer
  callPeers[targetId] = { 
    pc: cp, 
    name: targetName, 
    iceQueue: [] 
  };

  // ICE Candidates
  cp.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('call-ice', { targetId, candidate: event.candidate });
    }
  };

  // Track received
  cp.ontrack = (event) => {
    addRemoteVideo(targetId, event.streams[0], targetName);
  };

  return cp;
}

// Start Call (Caller)
async function startCall(targetId) {
  const stream = await ensureLocalStream();
  if (!stream) return;

  // Find name from UI
  let name = "Peer";
  const el = document.querySelector(`[data-userid="${targetId}"]`);
  if (el) name = el.dataset.username;

  const cp = createPeerConnection(targetId, name);
  
  // Add local tracks
  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const offer = await cp.createOffer();
  await cp.setLocalDescription(offer);

  socket.emit('call-offer', { targetId, offer });

  // Update Button State
  updateUserButton(targetId, 'calling');
}

// End Call
function endPeerCall(id, fromRemote = false) {
  const peer = callPeers[id];
  if (peer && peer.pc) {
    peer.pc.close();
  }
  delete callPeers[id];
  removeRemoteVideo(id);

  if (!fromRemote) {
    socket.emit('call-end', { targetId: id });
  }

  // Update Button State
  updateUserButton(id, 'idle');
}
window.endPeerCall = endPeerCall; // Global scope for HTML onclick

// SOCKET LISTENERS FOR CALLS
socket.on('ring-alert', ({ from, fromId }) => {
  if (confirm(`📞 Call from ${from}. Accept?`)) {
    startCall(fromId);
  }
});

socket.on('incoming-call', async ({ from, name, offer }) => {
  const stream = await ensureLocalStream();
  const cp = createPeerConnection(from, name);

  await cp.setRemoteDescription(new RTCSessionDescription(offer));
  if (stream) {
    stream.getTracks().forEach(t => cp.addTrack(t, stream));
  }

  const answer = await cp.createAnswer();
  await cp.setLocalDescription(answer);

  socket.emit('call-answer', { targetId: from, answer });
  
  // Process queued ICE
  const peer = callPeers[from];
  if (peer && peer.iceQueue.length) {
    peer.iceQueue.forEach(c => cp.addIceCandidate(c));
    peer.iceQueue = [];
  }

  updateUserButton(from, 'in-call');
});

socket.on('call-answer', async ({ from, answer }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    // Process queued ICE
    if (peer.iceQueue.length) {
      peer.iceQueue.forEach(c => peer.pc.addIceCandidate(c));
      peer.iceQueue = [];
    }
    updateUserButton(from, 'in-call');
  }
});

socket.on('call-ice', ({ from, candidate }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) {
    if (peer.pc.remoteDescription) {
      peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error(e));
    } else {
      peer.iceQueue.push(new RTCIceCandidate(candidate));
    }
  }
});

socket.on('call-end', ({ from }) => {
  endPeerCall(from, true);
});


// ==================================================================
// 5. STREAMING LOGIC (HOST TO VIEWERS)
// ==================================================================

if (startStreamBtn) startStreamBtn.addEventListener('click', async () => {
  if (!iAmHost) return alert("Only the Host can stream.");

  if (pc) {
    pc.close();
    pc = null;
  }
  
  pc = new RTCPeerConnection(iceConfig);

  // 1. Get Source (Screen or Cam)
  const quality = streamQuality ? streamQuality.value : '720';
  let streamToSend = null;

  if (quality === 'screen') {
    try {
      streamToSend = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      isScreenSharing = true;
    } catch(e) {
      console.error("Screen share cancelled");
      return;
    }
  } else {
    // Camera
    const height = parseInt(quality) || 720;
    await ensureLocalStream();
    streamToSend = localStream;
    isScreenSharing = false;
    // Attempt constraint apply
    try {
       const vt = streamToSend.getVideoTracks()[0];
       if (vt) await vt.applyConstraints({ height: { ideal: height } });
    } catch(e) {}
  }

  broadcastStream = streamToSend;

  // 2. Add Tracks
  broadcastStream.getTracks().forEach(t => pc.addTrack(t, broadcastStream));

  // 3. ICE Handler
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: event.candidate });
    }
  };

  // 4. Create Offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // 5. Send to Server
  socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });

  // UI Update
  isStreaming = true;
  startStreamBtn.textContent = "Live Streaming";
  startStreamBtn.classList.add('danger');
  if (hangupBtn) hangupBtn.disabled = false;
});

// Handshake Listeners
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

if (hangupBtn) hangupBtn.addEventListener('click', () => {
  // Stop Stream
  if (isStreaming && pc) {
    pc.close();
    pc = null;
    isStreaming = false;
    startStreamBtn.textContent = "Start Stream";
    startStreamBtn.classList.remove('danger');
  }
  // Stop Screen Share tracks if any
  if (isScreenSharing && broadcastStream) {
    broadcastStream.getTracks().forEach(t => t.stop());
    isScreenSharing = false;
  }
  // Stop all P2P calls
  Object.keys(callPeers).forEach(id => endPeerCall(id));
  
  hangupBtn.disabled = true;
});


// ==================================================================
// 6. TOGGLES (CAM / MIC / SCREEN)
// ==================================================================

if (toggleCamBtn) toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    toggleCamBtn.textContent = track.enabled ? "Camera Off" : "Camera On";
    toggleCamBtn.classList.toggle('danger', !track.enabled);
  }
});

if (toggleMicBtn) toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    toggleMicBtn.textContent = track.enabled ? "Mute" : "Unmute";
    toggleMicBtn.classList.toggle('danger', !track.enabled);
  }
});

// Screen Share Toggle (During call/stream)
if (shareScreenBtn) shareScreenBtn.addEventListener('click', async () => {
  if (!isScreenSharing) {
    // START SHARING
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      isScreenSharing = true;
      shareScreenBtn.textContent = "Stop Screen";
      shareScreenBtn.classList.add('danger');
      
      const screenTrack = screenStream.getVideoTracks()[0];
      
      // Handle "Stop" from browser UI
      screenTrack.onended = () => stopScreenSharing();

      // Show locally
      if (localVideo) localVideo.srcObject = screenStream;

      // Replace in PC (Stream)
      if (isStreaming && pc) {
        const sender = pc.getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      }
      // Replace in Calls
      Object.values(callPeers).forEach(peer => {
        const sender = peer.pc.getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      });

    } catch(e) {
      console.error("Screen share error", e);
    }
  } else {
    // STOP SHARING
    stopScreenSharing();
  }
});

function stopScreenSharing() {
  if (!isScreenSharing) return;
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
  }
  isScreenSharing = false;
  screenStream = null;
  shareScreenBtn.textContent = "Share Screen";
  shareScreenBtn.classList.remove('danger');

  // Revert to Cam
  if (localVideo) localVideo.srcObject = localStream;
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    if (isStreaming && pc) {
       const sender = pc.getSenders().find(s => s.track.kind === 'video');
       if (sender) sender.replaceTrack(camTrack);
    }
    Object.values(callPeers).forEach(peer => {
       const sender = peer.pc.getSenders().find(s => s.track.kind === 'video');
       if (sender) sender.replaceTrack(camTrack);
    });
  }
}


// ==================================================================
// 7. FILE SHARING (FULL IMPLEMENTATION)
// ==================================================================

if (fileInput) fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) {
    fileNameLabel.textContent = `${file.name} (${(file.size/1024).toFixed(1)} KB)`;
    sendFileBtn.disabled = false;
  } else {
    fileNameLabel.textContent = "No file selected";
    sendFileBtn.disabled = true;
  }
});

if (sendFileBtn) sendFileBtn.addEventListener('click', () => {
  const file = fileInput.files[0];
  if (!file) return;

  // Max size check (e.g. 50MB)
  const MAX_SIZE = 50 * 1024 * 1024; 
  if (file.size > MAX_SIZE) {
    alert("File is too large. Max 50MB.");
    return;
  }

  // Read File
  const reader = new FileReader();
  
  // UI Feedback
  sendFileBtn.textContent = "Sending...";
  sendFileBtn.disabled = true;

  reader.onload = (e) => {
    const dataUrl = e.target.result;
    
    // Send to Server
    socket.emit('file-share', {
      room: currentRoom,
      name: userName,
      fileName: file.name,
      fileType: file.type,
      fileData: dataUrl // sending as base64 dataURL
    });

    // Local Echo
    appendFileLog(userName, file.name, dataUrl, true);
    
    // Reset
    fileInput.value = '';
    fileNameLabel.textContent = "No file selected";
    sendFileBtn.textContent = "Send File";
  };
  
  reader.readAsDataURL(file);
});

socket.on('file-share', ({ name, fileName, fileData }) => {
  appendFileLog(name, fileName, fileData, false);
  // Optional: Switch tab to notify user
  if (tabFilesBtn && !tabFilesBtn.classList.contains('active')) {
    tabFilesBtn.style.color = 'var(--accent)'; // Highlight tab
  }
});

function appendFileLog(senderName, fileName, dataUrl, isMe) {
  if (!fileLog) return;
  const div = document.createElement('div');
  div.className = 'file-item';
  div.innerHTML = `
    <div>
      <strong>${isMe ? 'You' : senderName}</strong> shared: 
      <span style="color:var(--accent)">${fileName}</span>
    </div>
    <a href="${dataUrl}" download="${fileName}" class="btn small primary">Download</a>
  `;
  fileLog.appendChild(div);
  fileLog.scrollTop = fileLog.scrollHeight;
}


// ==================================================================
// 8. CHAT & EMOJIS
// ==================================================================

function appendChat(name, text, ts) {
  if (!chatLog) return;
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const div = document.createElement('div');
  div.className = 'chat-line';
  div.innerHTML = `
    <span class="chat-time">[${time}]</span>
    <strong>${name}:</strong> 
    <span>${text}</span>
  `;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

if (sendBtn) sendBtn.addEventListener('click', sendMessage);
if (chatInput) chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  
  socket.emit('chat-message', {
    room: currentRoom,
    name: userName,
    text: text
  });
  
  chatInput.value = '';
}

socket.on('chat-message', ({ name, text, ts }) => {
  appendChat(name, text, ts);
});

if (emojiStrip) emojiStrip.addEventListener('click', (e) => {
  if (e.target.classList.contains('emoji')) {
    chatInput.value += e.target.textContent;
    chatInput.focus();
  }
});


// ==================================================================
// 9. HOST CONTROLS & USER LIST
// ==================================================================

// Host: Update Title
if (updateTitleBtn) updateTitleBtn.addEventListener('click', () => {
  const val = streamTitleInput.value.trim();
  if (val) socket.emit('update-stream-title', val);
});

// Host: Update Slug
if (updateSlugBtn) updateSlugBtn.addEventListener('click', () => {
  const val = slugInput.value.trim();
  if (val) socket.emit('update-public-slug', val);
});

// Host: Lock Room
if (lockRoomBtn) lockRoomBtn.addEventListener('click', () => {
  // Logic handled by button state in renderUserList usually, or just emit toggle
  socket.emit('lock-room', true);
});

// Host: Kick (Global function)
window.kickUser = (id) => {
  if (confirm("Kick this user?")) {
    socket.emit('kick-user', id);
  }
};
socket.on('kicked', () => {
  alert("You have been kicked by the host.");
  window.location.reload();
});

// Global Ring
window.ringUser = (id) => {
  socket.emit('ring-user', id);
};


// 10. ROOM UPDATES (Main UI Sync)
socket.on('room-update', (data) => {
  const { users, ownerId, locked, streamTitle, publicSlug } = data;
  
  // Am I Host?
  iAmHost = (myId === ownerId);

  // Update Host Controls Visibility
  if (hostControls) {
    hostControls.style.display = iAmHost ? 'block' : 'none';
  }

  // Update Inputs
  if (streamTitleInput) {
    streamTitleInput.value = streamTitle || '';
    streamTitleInput.disabled = !iAmHost;
  }
  if (slugInput && iAmHost) {
    slugInput.value = publicSlug || '';
  }

  // Update Lock Button Text
  if (lockRoomBtn) {
    lockRoomBtn.textContent = locked ? "🔒 Unlock Room" : "🔓 Lock Room";
  }

  // Update Viewer Link
  if (streamLinkInput) {
    const roomIdToUse = publicSlug || currentRoom;
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomIdToUse)}`;
    streamLinkInput.value = url.toString();
  }

  // Render User List
  if (userList) {
    userList.innerHTML = '';
    users.forEach(u => {
      if (u.id === myId) return; // Skip self

      const div = document.createElement('div');
      div.className = 'user-item';
      div.dataset.userid = u.id;
      div.dataset.username = u.name;

      const isCaller = !!callPeers[u.id];
      const btnClass = isCaller ? 'action-btn danger' : 'action-btn';
      const btnText = isCaller ? 'End' : '📞 Call';
      const btnAction = isCaller ? `endPeerCall('${u.id}')` : `ringUser('${u.id}')`;

      div.innerHTML = `
        <span>${u.id === ownerId ? '👑' : ''} ${u.name}</span>
        <div class="user-actions">
           <button onclick="${btnAction}" class="${btnClass}">${btnText}</button>
           ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
        </div>
      `;
      userList.appendChild(div);
    });
  }
});

// Role Update
socket.on('role', (data) => {
  iAmHost = data.isHost;
  if (iAmHost && hostControls) hostControls.style.display = 'block';
});

socket.on('user-joined', ({ name }) => {
  appendChat('System', `${name} joined the room`, Date.now());
});

socket.on('user-left', ({ id }) => {
  endPeerCall(id, true);
});


// ==================================================================
// 11. HELPER: UPDATE BUTTON STATE
// ==================================================================
function updateUserButton(id, state) {
  // force a re-render or find specific button
  // Easier to wait for room-update or just manipulate DOM
  const list = document.getElementById('userList');
  if (!list) return;
  const item = list.querySelector(`div[data-userid="${id}"]`);
  if (!item) return;
  
  const actionBtn = item.querySelector('button:first-child'); 
  // Assuming first button is the Call/End button
  if (actionBtn) {
    if (state === 'calling' || state === 'in-call') {
      actionBtn.textContent = 'End';
      actionBtn.className = 'action-btn danger';
      actionBtn.setAttribute('onclick', `endPeerCall('${id}')`);
    } else {
      actionBtn.textContent = '📞 Call';
      actionBtn.className = 'action-btn';
      actionBtn.setAttribute('onclick', `ringUser('${id}')`);
    }
  }
}

if (openStreamBtn) openStreamBtn.addEventListener('click', () => {
    if (streamLinkInput.value) window.open(streamLinkInput.value, '_blank');
});
