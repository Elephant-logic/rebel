// REBEL MESSENGER HOST / GUEST CLIENT
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// STREAM PC
let pc = null;
let isStreaming = false;
let broadcastStream = null;

// CALL PEERS (Multi-user)
// peer: { pc, name, iceQueue }
const callPeers = {};      
const remoteStreams = {};

// Local media
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// Stream Source
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
const slugInput       = $('slugInput');
const updateSlugBtn   = $('updateSlugBtn');

// Media & Grid
const videoGrid       = $('videoGrid');
const localVideo      = $('localVideo');
const startStreamBtn  = $('startStreamBtn');
const streamQuality   = $('streamQuality'); 
const hangupBtn       = $('hangupBtn'); 
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

// --- VIDEO GRID ---
function addRemoteVideo(id, stream, name) {
  let existing = document.getElementById(`vid-${id}`);
  if (existing) {
    existing.querySelector('video').srcObject = stream;
    return;
  }
  const container = document.createElement('div');
  container.className = 'video-container';
  container.id = `vid-${id}`;
  container.innerHTML = `<h2>${name || 'Peer'}</h2><video autoplay playsinline></video>`;
  const vid = container.querySelector('video');
  vid.srcObject = stream;
  videoGrid.appendChild(container);
}

function removeRemoteVideo(id) {
  const el = document.getElementById(`vid-${id}`);
  if (el) el.remove();
}

// --- SETTINGS ---
async function getDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInput = devices.filter(d => d.kind === 'audioinput');
    const videoInput = devices.filter(d => d.kind === 'videoinput');

    if (audioSource) {
      const current = audioSource.value;
      audioSource.innerHTML = audioInput.map(d => `<option value="${d.deviceId}">${d.label || 'Mic ' + d.deviceId.slice(0,5)}</option>`).join('');
      if (current) audioSource.value = current;
    }
    if (videoSource) {
      const current = videoSource.value;
      videoSource.innerHTML = videoInput.map(d => `<option value="${d.deviceId}">${d.label || 'Cam ' + d.deviceId.slice(0,5)}</option>`).join('');
      if (current) videoSource.value = current;
    }
  } catch (e) { console.error('getDevices error:', e); }
}

async function switchMedia() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());

  const audioId = audioSource ? audioSource.value : "";
  const videoId = videoSource ? videoSource.value : "";

  // FIX: Don't use 'exact' if the ID is empty
  const constraints = {
    audio: audioId ? { deviceId: { exact: audioId } } : true,
    video: videoId ? { deviceId: { exact: videoId } } : true
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    localVideo.muted = true;

    // Refresh active connections with new tracks
    const replaceTrack = (pc, kind, track) => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === kind);
        if (sender && track) sender.replaceTrack(track);
    };

    if (isStreaming && pc) {
      replaceTrack(pc, 'video', localStream.getVideoTracks()[0]);
      replaceTrack(pc, 'audio', localStream.getAudioTracks()[0]);
    }
    
    Object.values(callPeers).forEach(peer => {
       if (peer.pc) {
          replaceTrack(peer.pc, 'video', localStream.getVideoTracks()[0]);
          replaceTrack(peer.pc, 'audio', localStream.getAudioTracks()[0]);
       }
    });

  } catch (e) { console.error("Switch Media Error", e); }
}

settingsBtn.addEventListener('click', async () => {
  settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
  if (settingsPanel.style.display === 'block') await getDevices();
});

closeSettingsBtn.addEventListener('click', () => {
  settingsPanel.style.display = 'none';
  switchMedia(); 
});

async function ensureLocalStream() {
  if (localStream && localStream.active) return localStream;
  await switchMedia(); 
  if (!localStream) {
      // Emergency Fallback
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      localVideo.muted = true;
  }
  return localStream;
}

// --- STREAMING LOGIC ---
async function startBroadcast() {
  if (!currentRoom) return alert('Join room first');
  if (!iAmHost) return alert('Only host can stream');

  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);
  pc.onicecandidate = e => {
      if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };

  const quality = streamQuality.value;
  if (quality === 'screen') {
      try {
        broadcastStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        isScreenSharing = true;
      } catch(e) { return; }
  } else {
      const height = parseInt(quality) || 720;
      await ensureLocalStream(); 
      try { await localStream.getVideoTracks()[0].applyConstraints({ height: { ideal: height } }); } catch(e) {}
      broadcastStream = localStream;
      isScreenSharing = false;
  }

  broadcastStream.getTracks().forEach(t => pc.addTrack(t, broadcastStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  
  isStreaming = true;
  startStreamBtn.textContent = "Live";
  startStreamBtn.classList.add('danger');
  hangupBtn.disabled = false;
}

// --- SOCKET EVENTS ---
socket.on('connect', () => { setSignal(true); myId = socket.id; });
socket.on('disconnect', () => setSignal(false));

socket.on('role', ({ isHost, streamTitle, publicSlug }) => {
  iAmHost = isHost;
  if (hostControls) hostControls.style.display = isHost ? 'block' : 'none';
  if (isHost) {
      if (streamTitleInput) streamTitleInput.value = streamTitle || '';
      if (slugInput) slugInput.value = publicSlug || '';
  }
});

socket.on('room-update', ({ users, ownerId, locked, streamTitle, publicSlug }) => {
  renderUserList(users, ownerId);
  if (lockRoomBtn) {
    lockRoomBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
    lockRoomBtn.onclick = () => { if (iAmHost) socket.emit('lock-room', !locked); };
  }
  if (streamTitleInput && !iAmHost) {
      streamTitleInput.value = streamTitle || '';
      streamTitleInput.disabled = true;
  }
  // Link update
  const linkId = publicSlug || currentRoom;
  if (linkId && streamLinkInput) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(linkId)}`;
    streamLinkInput.value = url.toString();
  }
});

socket.on('user-joined', ({ id, name }) => {
  if (id !== myId) appendChat('System', `${name} joined.`, Date.now());
  if (iAmHost && isStreaming) reofferStream().catch(console.error);
});

// Stream Handshake
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) try { await pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch (e) {}
});
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
});

// --- JOIN ---
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
  ensureLocalStream();
});
leaveBtn.addEventListener('click', () => window.location.reload());

// --- CALL PEER LOGIC ---
function createCallPC(targetId, targetName) {
  const cp = new RTCPeerConnection(iceConfig);
  // Add an ICE Queue to handle candidates arriving before answer
  callPeers[targetId] = { pc: cp, name: targetName, iceQueue: [] };

  cp.onicecandidate = (e) => { 
      if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate }); 
  };
  cp.ontrack = (event) => addRemoteVideo(targetId, event.streams[0], targetName);
  
  return cp;
}

// FLUSH ICE QUEUE
async function flushIceQueue(id) {
    const peer = callPeers[id];
    if (!peer || !peer.pc || !peer.iceQueue.length) return;
    for (const candidate of peer.iceQueue) {
        try { await peer.pc.addIceCandidate(candidate); } catch(e) {}
    }
    peer.iceQueue = [];
}

async function callPeer(targetId) {
  const stream = await ensureLocalStream();
  const peerEl = document.querySelector(`[data-userid="${targetId}"]`);
  const cp = createCallPC(targetId, peerEl ? peerEl.dataset.username : "Peer"); 
  
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
  
  // Now we have RemoteDesc, flush any early ICE candidates
  await flushIceQueue(from);

  const btn = document.querySelector(`button[onclick="endPeerCall('${from}')"]`);
  if(btn) { btn.disabled = false; btn.classList.add('danger'); }
});

socket.on('call-answer', async ({ from, answer }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIceQueue(from);
  }
});

socket.on('call-ice', ({ from, candidate }) => {
  const peer = callPeers[from];
  if (peer && peer.pc) {
      if (peer.pc.remoteDescription) {
          peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
          // Queue it if answer hasn't arrived yet
          peer.iceQueue.push(new RTCIceCandidate(candidate));
      }
  }
});

socket.on('call-end', ({ from }) => endPeerCall(from, true));
socket.on('user-left', ({ id }) => endPeerCall(id, true));

function endPeerCall(id, isIncomingSignal) {
  const peer = callPeers[id];
  if (peer && peer.pc) try { peer.pc.close(); } catch(e){}
  delete callPeers[id];
  removeRemoteVideo(id);
  if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
  const btn = document.querySelector(`button[onclick="endPeerCall('${id}')"]`);
  if(btn) { btn.disabled = true; btn.classList.remove('danger'); }
}
window.endPeerCall = endPeerCall;

// --- LISTENERS ---
if (updateTitleBtn) updateTitleBtn.addEventListener('click', () => {
    const title = streamTitleInput.value.trim();
    if (title) socket.emit('update-stream-title', title);
});
if (updateSlugBtn) updateSlugBtn.addEventListener('click', () => {
    const slug = slugInput.value.trim();
    if (slug) socket.emit('update-public-slug', slug);
});
if (startStreamBtn) startStreamBtn.addEventListener('click', startBroadcast);
if (toggleCamBtn) toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    track.enabled = !track.enabled;
    toggleCamBtn.textContent = track.enabled ? 'Camera Off' : 'Camera On';
});
if (toggleMicBtn) toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    toggleMicBtn.textContent = track.enabled ? 'Mute' : 'Unmute';
});
if (hangupBtn) hangupBtn.addEventListener('click', () => {
    if (isStreaming) { if (pc) pc.close(); pc = null; isStreaming = false; startStreamBtn.textContent = 'Start Stream'; startStreamBtn.classList.remove('danger'); }
    Object.keys(callPeers).forEach(id => endPeerCall(id));
    hangupBtn.disabled = true;
});
if (openStreamBtn) openStreamBtn.addEventListener('click', () => {
    if (streamLinkInput && streamLinkInput.value) window.open(streamLinkInput.value, '_blank');
});

// Chat / Utils
function appendChat(name, text, ts) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}
socket.on('chat-message', (d) => appendChat(d.name, d.text, d.ts));
if (sendBtn) sendBtn.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if(text) socket.emit('chat-message', { room: currentRoom, name: userName, text });
    chatInput.value = '';
});
if (emojiStrip) emojiStrip.addEventListener('click', (e) => {
    if (e.target.classList.contains('emoji')) { chatInput.value += e.target.textContent; chatInput.focus(); }
});
function renderUserList(users, ownerId) {
  userList.innerHTML = '';
  users.forEach(u => {
      if (u.id === myId) return;
      const div = document.createElement('div');
      div.className = 'user-item';
      div.dataset.userid = u.id;
      div.dataset.username = u.name;
      const inCall = !!callPeers[u.id];
      div.innerHTML = `
        <span>${u.id === ownerId ? '👑' : ''} ${u.name}</span>
        <div class="user-actions">
           <button onclick="ringUser('${u.id}')" class="action-btn ring">📞</button>
           <button onclick="endPeerCall('${u.id}')" class="${inCall?'action-btn danger':'action-btn'}" ${inCall?'':'disabled'}>End</button>
           ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
        </div>
      `;
      userList.appendChild(div);
  });
}
window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);
async function reofferStream() {
  if (!pc || !isStreaming) return;
  try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('webrtc-offer', { room: currentRoom, sdp: offer }); } catch (e) {}
}
