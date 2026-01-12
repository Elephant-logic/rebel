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
// callPeers = { [socketId]: { pc: RTCPeerConnection, name: string } }
const callPeers = {};      
const remoteStreams = {};  // { socketId: MediaStream }

// Local media
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let iceCandidatesQueue = [];

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

// --- VIDEO GRID MANAGEMENT (The Fix for "Messed Up" Video) ---
function addRemoteVideo(id, stream, name) {
  // Check if already exists
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

// --- HOST TITLE MANAGEMENT ---
if (updateTitleBtn) {
  updateTitleBtn.addEventListener('click', () => {
    const title = streamTitleInput.value.trim();
    if (title) socket.emit('update-stream-title', title);
  });
}

// --- SOCKET EVENTS ---
socket.on('connect', () => {
  setSignal(true);
  myId = socket.id;
});
socket.on('disconnect', () => setSignal(false));

socket.on('role', ({ isHost, streamTitle }) => {
  iAmHost = isHost;
  // ONLY Host sees host controls
  if (hostControls) hostControls.style.display = isHost ? 'block' : 'none';
  if (streamTitleInput && isHost) streamTitleInput.value = streamTitle || '';
});

socket.on('room-update', ({ users, ownerId, locked, streamTitle }) => {
  renderUserList(users, ownerId);
  
  // Lock button text
  if (lockRoomBtn) {
    lockRoomBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
    // Only host can click logic handled in onclick
    lockRoomBtn.onclick = () => {
       if (iAmHost) socket.emit('lock-room', !locked);
    };
  }
  
  // Title update (for guests seeing what the host set)
  if (streamTitleInput && !iAmHost) {
      streamTitleInput.value = streamTitle || '';
      streamTitleInput.disabled = true; // Guests can't edit
  }
});

// ... (Keep existing kick/ring handlers) ...
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
  
  // Generate Viewer Link
  const url = new URL(window.location.href);
  // Assume viewer is viewer.html or view.html depending on your setup
  url.pathname = url.pathname.replace('index.html', '') + 'view.html'; 
  url.search = `?room=${encodeURIComponent(room)}`;
  streamLinkInput.value = url.toString();
  
  // Auto-start local media
  ensureLocalStream();
});

leaveBtn.addEventListener('click', () => window.location.reload());

// --- MEDIA HANDLING ---
async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Mute self locally
  } catch (e) {
    console.error("Media Error", e);
    alert("Could not access camera/mic");
  }
  return localStream;
}

// --- CALL LOGIC (1:1 Multi-Mesh) ---

function createCallPC(targetId, targetName) {
  const cp = new RTCPeerConnection(iceConfig);

  cp.onicecandidate = (e) => {
    if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate });
  };

  cp.ontrack = (event) => {
    const stream = event.streams[0];
    remoteStreams[targetId] = stream; // Store for broadcast
    addRemoteVideo(targetId, stream, targetName);
  };

  callPeers[targetId] = { pc: cp, name: targetName };
  return cp;
}

async function callPeer(targetId) {
  const stream = await ensureLocalStream();
  // We need the name of the person we are calling (look up in DOM for now)
  const peerEl = document.querySelector(`[data-userid="${targetId}"]`);
  const peerName = peerEl ? peerEl.dataset.username : "Peer";

  const cp = createCallPC(targetId, peerName); 
  
  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const offer = await cp.createOffer();
  await cp.setLocalDescription(offer);
  socket.emit('call-offer', { targetId, offer });
}

socket.on('incoming-call', async ({ from, name, offer }) => {
  const stream = await ensureLocalStream();
  const cp = createCallPC(from, name);

  await cp.setRemoteDescription(new RTCSessionDescription(offer));
  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const answer = await cp.createAnswer();
  await cp.setLocalDescription(answer);

  socket.emit('call-answer', { targetId: from, answer });
});

socket.on('call-answer', async ({ from, answer }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('call-ice', ({ from, candidate }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('call-end', ({ from }) => {
  endPeerCall(from, true); // true = incoming signal
});

socket.on('user-left', ({ id }) => {
  endPeerCall(id, true);
});

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
}
window.endPeerCall = endPeerCall; // For global button usage

// --- STREAMING LOGIC (Host -> Viewers) ---
async function startBroadcast() {
  if (!currentRoom) return alert('Join room first');
  if (!iAmHost) return alert('Only host can stream');

  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);
  pc.onicecandidate = e => {
      if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };

  // Determine source
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
  startStreamBtn.classList.add('danger'); // Red to indicate live
}

async function reofferStream() {
  if (!pc || !isStreaming) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  } catch (e) {
    console.error('reofferStream error:', e);
  }
}

if (startStreamBtn) startStreamBtn.addEventListener('click', startBroadcast);

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

// Render User List
function renderUserList(users, ownerId) {
  userList.innerHTML = '';
  users.forEach(u => {
      if (u.id === myId) return; // Don't list self
      
      const div = document.createElement('div');
      div.className = 'user-item';
      // Store ID and Name in dataset for easier access later
      div.dataset.userid = u.id;
      div.dataset.username = u.name;
      
      div.innerHTML = `
        <span>${u.id === ownerId ? '👑' : ''} ${u.name}</span>
        <div class="user-actions">
           <button onclick="ringUser('${u.id}')" class="action-btn ring">📞 Call</button>
           ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
        </div>
      `;
      userList.appendChild(div);
  });
}

window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);
