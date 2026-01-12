// REBEL MESSENGER HOST / GUEST CLIENT
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// STREAM PC (for host → viewers)
let pc = null;
let isStreaming = false;
let broadcastStream = null;

// CALL PEERS (Multi-user)
const callPeers = {};      // { socketId: { pc, name } }
const remoteStreams = {};  // { socketId: MediaStream }

// Local media
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// Stream Source (Default to Host)
let streamSource = { type: 'host', id: null };

// ICE Config
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- DOM ELEMENTS ---
const $ = id => document.getElementById(id);

// Connection
const nameInput       = $('nameInput');
const roomInput       = $('roomInput');
const joinBtn         = $('joinBtn');
const leaveBtn        = $('leaveBtn');
const signalStatus    = $('signalStatus');
const roomInfo        = $('roomInfo');

// Host Controls
const hostControls    = $('hostControls');
const lockRoomBtn     = $('lockRoomBtn');
const streamTitleInput= $('streamTitleInput');
const updateTitleBtn  = $('updateTitleBtn');
const slugInput       = $('slugInput');      // NEW
const updateSlugBtn   = $('updateSlugBtn');  // NEW

// Media & Grid
const videoGrid       = $('videoGrid');
const localVideo      = $('localVideo');
const startStreamBtn  = $('startStreamBtn');
const hangupBtn       = $('hangupBtn'); 
const shareScreenBtn  = $('shareScreenBtn');
const toggleCamBtn    = $('toggleCamBtn');
const toggleMicBtn    = $('toggleMicBtn');
const settingsBtn     = $('settingsBtn');
const streamLinkInput = $('streamLinkInput');
const openStreamBtn   = $('openStreamBtn');

// Settings & Chat
const settingsPanel   = $('settingsPanel');
const audioSource     = $('audioSource');
const videoSource     = $('videoSource');
const closeSettingsBtn= $('closeSettingsBtn');
const chatLog         = $('chatLog');
const chatInput       = $('chatInput');
const sendBtn         = $('sendBtn');
const emojiStrip      = $('emojiStrip');
const fileInput       = $('fileInput');
const sendFileBtn     = $('sendFileBtn');
const fileLog         = $('fileLog');
const userList        = $('userList');

// Tabs
const tabs = { chat: $('tabChatBtn'), files: $('tabFilesBtn'), users: $('tabUsersBtn') };
const contents = { chat: $('tabContentChat'), files: $('tabContentFiles'), users: $('tabContentUsers') };

function switchTab(name) {
  Object.values(tabs).forEach(t => t.classList.remove('active'));
  Object.values(contents).forEach(c => c.classList.remove('active'));
  if (tabs[name]) tabs[name].classList.add('active');
  if (contents[name]) contents[name].classList.add('active');
}
Object.keys(tabs).forEach(k => tabs[k].addEventListener('click', () => switchTab(k)));

// --- SIGNALING UI ---
function setSignal(connected) {
  signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
  signalStatus.className = connected ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

// --- VIDEO GRID MANAGEMENT ---
function addRemoteVideo(id, stream, name) {
  let existing = document.getElementById(`vid-${id}`);
  if (existing) {
    existing.querySelector('video').srcObject = stream;
    return;
  }

  const container = document.createElement('div');
  container.className = 'video-container';
  container.id = `vid-${id}`;
  container.innerHTML = `
    <h2>${name || 'Peer'}</h2>
    <video autoplay playsinline></video>
  `;
  const vid = container.querySelector('video');
  vid.srcObject = stream;
  videoGrid.appendChild(container);
}

function removeRemoteVideo(id) {
  const el = document.getElementById(`vid-${id}`);
  if (el) el.remove();
}

// --- HOST TITLE & SLUG MANAGEMENT ---
if (updateTitleBtn) {
  updateTitleBtn.addEventListener('click', () => {
    const title = streamTitleInput.value.trim();
    if (title) socket.emit('update-stream-title', title);
  });
}

// NEW: Update Slug Listener
if (updateSlugBtn) {
  updateSlugBtn.addEventListener('click', () => {
    const slug = slugInput.value.trim();
    if (slug) socket.emit('update-public-slug', slug);
  });
}

// --- SOCKET EVENTS ---
socket.on('connect', () => {
  setSignal(true);
  myId = socket.id;
});
socket.on('disconnect', () => setSignal(false));

socket.on('role', ({ isHost, streamTitle, publicSlug }) => {
  iAmHost = isHost;
  if (hostControls) hostControls.style.display = isHost ? 'block' : 'none';
  
  if (isHost) {
      if (streamTitleInput) streamTitleInput.value = streamTitle || '';
      if (slugInput) slugInput.value = publicSlug || '';
  }
  
  // Refresh user list if we just became host
  // (No specific event needed, next update will fix it)
});

socket.on('room-update', ({ users, ownerId, locked, streamTitle, publicSlug }) => {
  renderUserList(users, ownerId);
  
  if (lockRoomBtn) {
    lockRoomBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
    lockRoomBtn.onclick = () => {
       if (iAmHost) socket.emit('lock-room', !locked);
    };
  }
  
  // Update Title Input (Read-only for guests)
  if (streamTitleInput && !iAmHost) {
      streamTitleInput.value = streamTitle || '';
      streamTitleInput.disabled = true;
  }

  // UPDATE VIEWER LINK BOX
  // If a slug exists, use it. Otherwise use the raw Room ID.
  const linkId = publicSlug || currentRoom;
  if (linkId && streamLinkInput) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(linkId)}`;
    streamLinkInput.value = url.toString();
  }
});

socket.on('kicked', () => { alert('Kicked by host'); window.location.reload(); });
socket.on('ring-alert', ({ from, fromId }) => {
    if(confirm(`🔔 ${from} is calling you! Accept?`)) {
        callPeer(fromId);
    }
});
socket.on('room-error', (msg) => { alert(msg); });

socket.on('user-joined', ({ id, name }) => {
  if (id !== myId) appendChat('System', `${name} joined.`, Date.now());
  if (iAmHost && isStreaming) reofferStream().catch(console.error);
});

// --- CRITICAL HANDSHAKE HANDLERS ---
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (e) { console.error("Error setting remote desc:", e); }
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) { console.error("Error adding ice:", e); }
  }
});

// --- JOIN / LEAVE ---
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) return alert('Enter Room ID');
  currentRoom = room;
  userName = nameInput.value.trim() || 'Anon';

  socket.connect();
  socket.emit('join-room', { room: currentRoom, name: userName });

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  roomInfo.textContent = `ID: ${room}`;
  
  // Set initial link (will update if slug exists)
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace('index.html', '') + 'view.html';
  url.search = `?room=${encodeURIComponent(room)}`;
  streamLinkInput.value = url.toString();
  
  ensureLocalStream();
});

leaveBtn.addEventListener('click', () => window.location.reload());

// --- MEDIA HANDLING ---
async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; 
  } catch (e) {
    console.error("Media Error", e);
    alert("Could not access camera/mic");
  }
  return localStream;
}

// --- CALL LOGIC ---
function createCallPC(targetId, targetName) {
  const cp = new RTCPeerConnection(iceConfig);

  cp.onicecandidate = (e) => {
    if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate });
  };

  cp.ontrack = (event) => {
    const stream = event.streams[0];
    remoteStreams[targetId] = stream;
    addRemoteVideo(targetId, stream, targetName);
  };

  callPeers[targetId] = { pc: cp, name: targetName };
  return cp;
}

async function callPeer(targetId) {
  const stream = await ensureLocalStream();
  const peerEl = document.querySelector(`[data-userid="${targetId}"]`);
  const peerName = peerEl ? peerEl.dataset.username : "Peer";
  const cp = createCallPC(targetId, peerName); 
  
  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const offer = await cp.createOffer();
  await cp.setLocalDescription(offer);
  socket.emit('call-offer', { targetId, offer });
  
  const btn = document.querySelector(`button[onclick="endPeerCall('${targetId}')"]`);
  if(btn) { btn.disabled = false; btn.classList.add('danger'); }
}

socket.on('incoming-call', async ({ from, name, offer }) => {
  const stream = await ensureLocalStream();
  const cp = createCallPC(from, name);

  await cp.setRemoteDescription(new RTCSessionDescription(offer));
  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const answer = await cp.createAnswer();
  await cp.setLocalDescription(answer);

  socket.emit('call-answer', { targetId: from, answer });
  
  const btn = document.querySelector(`button[onclick="endPeerCall('${from}')"]`);
  if(btn) { btn.disabled = false; btn.classList.add('danger'); }
});

socket.on('call-answer', async ({ from, answer }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('call-ice', ({ from, candidate }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('call-end', ({ from }) => endPeerCall(from, true));
socket.on('user-left', ({ id }) => endPeerCall(id, true));

function endPeerCall(id, isIncomingSignal) {
  const peer = callPeers[id];
  if (peer && peer.pc) {
    try { peer.pc.close(); } catch(e){}
  }
  delete callPeers[id];
  delete remoteStreams[id];
  removeRemoteVideo(id);
  
  if (!isIncomingSignal) {
      socket.emit('call-end', { targetId: id });
  }
  
  const btn = document.querySelector(`button[onclick="endPeerCall('${id}')"]`);
  if(btn) { btn.disabled = true; btn.classList.remove('danger'); }
}
window.endPeerCall = endPeerCall;

// --- STREAMING LOGIC ---
async function startBroadcast() {
  if (!currentRoom) return alert('Join room first');
  if (!iAmHost) return alert('Only host can stream');

  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);
  pc.onicecandidate = e => {
      if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };

  let streamToSend = localStream;
  if (streamSource.type === 'user' && remoteStreams[streamSource.id]) {
      streamToSend = remoteStreams[streamSource.id];
  }
  if (isScreenSharing && screenStream) streamToSend = screenStream;

  if (!streamToSend) streamToSend = await ensureLocalStream();
  broadcastStream = streamToSend;

  broadcastStream.getTracks().forEach(t => pc.addTrack(t, broadcastStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  
  isStreaming = true;
  startStreamBtn.textContent = "Streaming (Live)";
  startStreamBtn.classList.add('danger');
  hangupBtn.disabled = false;
}

async function reofferStream() {
  if (!pc || !isStreaming) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  } catch (e) { console.error(e); }
}

if (startStreamBtn) startStreamBtn.addEventListener('click', startBroadcast);

// --- BUTTON LISTENERS ---
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    track.enabled = !track.enabled;
    toggleCamBtn.textContent = track.enabled ? 'Camera Off' : 'Camera On';
    toggleCamBtn.classList.toggle('danger', !track.enabled);
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    toggleMicBtn.textContent = track.enabled ? 'Mute' : 'Unmute';
    toggleMicBtn.classList.toggle('danger', !track.enabled);
  });
}

if (shareScreenBtn) {
  shareScreenBtn.addEventListener('click', async () => {
    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        isScreenSharing = true;
        shareScreenBtn.textContent = 'Stop Screen';
        shareScreenBtn.classList.add('danger');
        
        localVideo.srcObject = screenStream;
        if (isStreaming && pc) {
             const sender = pc.getSenders().find(s => s.track.kind === 'video');
             if (sender) sender.replaceTrack(screenStream.getVideoTracks()[0]);
        }
        screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch(e) { console.error(e); }
    } else {
      stopScreenShare();
    }
  });
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  isScreenSharing = false;
  shareScreenBtn.textContent = 'Share Screen';
  shareScreenBtn.classList.remove('danger');
  
  localVideo.srcObject = localStream;
  if (isStreaming && pc && localStream) {
      const sender = pc.getSenders().find(s => s.track.kind === 'video');
      if (sender) sender.replaceTrack(localStream.getVideoTracks()[0]);
  }
}

if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    if (isStreaming) {
      if (pc) pc.close();
      pc = null;
      isStreaming = false;
      startStreamBtn.textContent = 'Start Stream';
      startStreamBtn.classList.remove('danger');
    }
    stopScreenShare();
    Object.keys(callPeers).forEach(id => endPeerCall(id));
    hangupBtn.disabled = true;
  });
}

if (openStreamBtn) {
    openStreamBtn.addEventListener('click', () => {
        if (streamLinkInput && streamLinkInput.value) window.open(streamLinkInput.value, '_blank');
    });
}

// --- CHAT & UTILS ---
function appendChat(name, text, ts) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  line.innerHTML = `<strong>${name}</strong> <small>${t}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

socket.on('chat-message', (d) => appendChat(d.name, d.text, d.ts));

if (sendBtn) sendBtn.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if(text) socket.emit('chat-message', { room: currentRoom, name: userName, text });
    chatInput.value = '';
});

if (emojiStrip) {
  emojiStrip.addEventListener('click', (e) => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}

// RENDER USER LIST
function renderUserList(users, ownerId) {
  userList.innerHTML = '';
  users.forEach(u => {
      if (u.id === myId) return; // Don't list self
      
      const div = document.createElement('div');
      div.className = 'user-item';
      div.dataset.userid = u.id;
      div.dataset.username = u.name;
      
      const inCall = !!callPeers[u.id];
      const endBtnClass = inCall ? 'action-btn danger' : 'action-btn';
      const endBtnDisabled = inCall ? '' : 'disabled';
      
      div.innerHTML = `
        <span>${u.id === ownerId ? '👑' : ''} ${u.name}</span>
        <div class="user-actions">
           <button onclick="ringUser('${u.id}')" class="action-btn ring">📞</button>
           <button onclick="endPeerCall('${u.id}')" class="${endBtnClass}" ${endBtnDisabled}>End</button>
           ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
        </div>
      `;
      userList.appendChild(div);
  });
}

window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);
