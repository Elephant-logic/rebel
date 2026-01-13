// REBEL MESSENGER HOST / GUEST CLIENT
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// CHAT STATE
let activeChatMode = 'public'; // 'public' or 'private'

// STREAM PC
let pc = null;
let isStreaming = false;
let broadcastStream = null;

// CALL PEERS
const callPeers = {};      
const remoteStreams = {};  

// Local media
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- DOM ---
const $ = id => document.getElementById(id);

const nameInput       = $('nameInput');
const roomInput       = $('roomInput');
const joinBtn         = $('joinBtn');
const leaveBtn        = $('leaveBtn');
const signalStatus    = $('signalStatus');
const roomInfo        = $('roomInfo');

const hostControls    = $('hostControls');
const lockRoomBtn     = $('lockRoomBtn');
const streamTitleInput= $('streamTitleInput');
const updateTitleBtn  = $('updateTitleBtn');

const videoGrid       = $('videoGrid');
const localVideo      = $('localVideo');
const startStreamBtn  = $('startStreamBtn');
const hangupBtn       = $('hangupBtn'); 
const shareScreenBtn  = $('shareScreenBtn');
const toggleCamBtn    = $('toggleCamBtn');
const toggleMicBtn    = $('toggleMicBtn');
const settingsBtn     = $('settingsBtn');
const streamLinkInput = $('streamLinkInput');

const settingsPanel   = $('settingsPanel');
const audioSource     = $('audioSource');
const videoSource     = $('videoSource');
const closeSettingsBtn= $('closeSettingsBtn');

// CHAT ELEMENTS
const chatInput       = $('chatInput');
const sendBtn         = $('sendBtn');
const emojiStrip      = $('emojiStrip');
const btnPublicChat   = $('btnPublicChat');
const btnPrivateChat  = $('btnPrivateChat');
const chatLogPublic   = $('chatLogPublic');
const chatLogPrivate  = $('chatLogPrivate');
const userList        = $('userList');

const tabs = { chat: $('tabChatBtn'), files: $('tabFilesBtn'), users: $('tabUsersBtn') };
const contents = { chat: $('tabContentChat'), files: $('tabContentFiles'), users: $('tabContentUsers') };

function switchTab(name) {
  Object.values(tabs).forEach(t => t.classList.remove('active'));
  Object.values(contents).forEach(c => c.classList.remove('active'));
  if (tabs[name]) tabs[name].classList.add('active');
  if (contents[name]) contents[name].classList.add('active');
}
Object.keys(tabs).forEach(k => tabs[k].addEventListener('click', () => switchTab(k)));

// --- CHAT TAB LOGIC ---
function switchChatMode(mode) {
    activeChatMode = mode;
    
    if (mode === 'public') {
        btnPublicChat.classList.add('active');
        btnPrivateChat.classList.remove('active');
        chatLogPublic.style.display = 'block';
        chatLogPrivate.style.display = 'none';
        btnPublicChat.classList.remove('has-new');
        chatLogPublic.scrollTop = chatLogPublic.scrollHeight;
    } else {
        btnPrivateChat.classList.add('active');
        btnPublicChat.classList.remove('active');
        chatLogPrivate.style.display = 'block';
        chatLogPublic.style.display = 'none';
        btnPrivateChat.classList.remove('has-new');
        chatLogPrivate.scrollTop = chatLogPrivate.scrollHeight;
    }
}
if(btnPublicChat) btnPublicChat.addEventListener('click', () => switchChatMode('public'));
if(btnPrivateChat) btnPrivateChat.addEventListener('click', () => switchChatMode('private'));

// --- SIGNALING UI ---
function setSignal(connected) {
  signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
  signalStatus.className = connected ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

// --- DEVICE SETTINGS ---
if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    const isHidden = settingsPanel.style.display === 'none';
    settingsPanel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) getDevices(); 
  });
}
if (closeSettingsBtn) {
  closeSettingsBtn.addEventListener('click', () => settingsPanel.style.display = 'none');
}

async function getDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioSource.innerHTML = '';
    videoSource.innerHTML = '';

    devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      if (device.kind === 'audioinput') {
        option.text = device.label || `Microphone ${audioSource.length + 1}`;
        audioSource.appendChild(option);
      } else if (device.kind === 'videoinput') {
        option.text = device.label || `Camera ${videoSource.length + 1}`;
        videoSource.appendChild(option);
      }
    });

    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      const videoTrack = localStream.getVideoTracks()[0];
      if (audioTrack && audioTrack.getSettings().deviceId) audioSource.value = audioTrack.getSettings().deviceId;
      if (videoTrack && videoTrack.getSettings().deviceId) videoSource.value = videoTrack.getSettings().deviceId;
    }
  } catch (e) { console.error(e); }
}

audioSource.addEventListener('change', startLocalMedia);
videoSource.addEventListener('change', startLocalMedia);

// --- MEDIA HANDLING ---
async function startLocalMedia() {
  if (localStream) localStream.getTracks().forEach(track => track.stop());

  const constraints = {
    audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
    video: { deviceId: videoSource.value ? { exact: videoSource.value } : undefined }
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    localVideo.muted = true;

    if (isStreaming && pc) replaceStreamTracks(pc, localStream);
    if (hangupBtn) hangupBtn.disabled = false;
    getDevices();
  } catch (e) {
    console.error("Media Error:", e);
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localVideo.srcObject = localStream;
    } catch(err) { alert("Could not start camera/mic"); }
  }
}

function replaceStreamTracks(peerConnection, newStream) {
    const videoTrack = newStream.getVideoTracks()[0];
    const audioTrack = newStream.getAudioTracks()[0];
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
    if (videoSender && videoTrack) videoSender.replaceTrack(videoTrack);
    if (audioSender && audioTrack) audioSender.replaceTrack(audioTrack);
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
  container.querySelector('video').srcObject = stream;
  videoGrid.appendChild(container);
}

function removeRemoteVideo(id) {
  const el = document.getElementById(`vid-${id}`);
  if (el) el.remove();
}

// --- SOCKET EVENTS ---
socket.on('connect', () => { setSignal(true); myId = socket.id; });
socket.on('disconnect', () => setSignal(false));
socket.on('role', ({ isHost, streamTitle }) => {
  iAmHost = isHost;
  if (hostControls) hostControls.style.display = isHost ? 'block' : 'none';
  if (streamTitleInput && isHost) streamTitleInput.value = streamTitle || '';
});
socket.on('room-update', ({ users, ownerId, locked, streamTitle }) => {
  renderUserList(users, ownerId);
  if (lockRoomBtn) {
    lockRoomBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
    lockRoomBtn.onclick = () => { if (iAmHost) socket.emit('lock-room', !locked); };
  }
  if (streamTitleInput && !iAmHost) {
      streamTitleInput.value = streamTitle || '';
      streamTitleInput.disabled = true;
  }
});

socket.on('kicked', () => { alert('Kicked'); window.location.reload(); });
socket.on('ring-alert', ({ from, fromId }) => {
    if(confirm(`📞 ${from} is calling! Accept?`)) callPeer(fromId);
});

// Join
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
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace('index.html', '') + 'view.html';
  url.search = `?room=${encodeURIComponent(room)}`;
  streamLinkInput.value = url.toString();
  startLocalMedia();
});
leaveBtn.addEventListener('click', () => window.location.reload());

// Call Logic
function createCallPC(targetId, targetName) {
  const cp = new RTCPeerConnection(iceConfig);
  cp.onicecandidate = (e) => { if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate }); };
  cp.ontrack = (event) => {
    remoteStreams[targetId] = event.streams[0];
    addRemoteVideo(targetId, event.streams[0], targetName);
  };
  callPeers[targetId] = { pc: cp, name: targetName };
  return cp;
}
async function callPeer(targetId) {
  if (!localStream) await startLocalMedia();
  const peerEl = document.querySelector(`[data-userid="${targetId}"]`);
  const cp = createCallPC(targetId, peerEl ? peerEl.dataset.username : "Peer"); 
  localStream.getTracks().forEach(t => cp.addTrack(t, localStream));
  const offer = await cp.createOffer();
  await cp.setLocalDescription(offer);
  socket.emit('call-offer', { targetId, offer });
  hangupBtn.disabled = false;
}
socket.on('incoming-call', async ({ from, name, offer }) => {
  if (!localStream) await startLocalMedia();
  const cp = createCallPC(from, name);
  await cp.setRemoteDescription(new RTCSessionDescription(offer));
  localStream.getTracks().forEach(t => cp.addTrack(t, localStream));
  const answer = await cp.createAnswer();
  await cp.setLocalDescription(answer);
  socket.emit('call-answer', { targetId: from, answer });
  hangupBtn.disabled = false;
});
socket.on('call-answer', async ({ from, answer }) => {
    if (callPeers[from]) await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer));
});
socket.on('call-ice', ({ from, candidate }) => {
    if (callPeers[from]) callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate));
});
socket.on('call-end', ({ from }) => endPeerCall(from, true));
socket.on('user-left', ({ id }) => endPeerCall(id, true));

function endPeerCall(id, isIncomingSignal) {
  if (callPeers[id]) { try { callPeers[id].pc.close(); } catch(e){} }
  delete callPeers[id];
  delete remoteStreams[id];
  removeRemoteVideo(id);
  if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
}

// Stream Logic
async function startBroadcast() {
  if (!currentRoom) return alert('Join room first');
  if (!iAmHost) return alert('Only host can stream');
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);
  pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate }); };

  let streamToSend = isScreenSharing && screenStream ? screenStream : localStream;
  if (!streamToSend) streamToSend = await startLocalMedia();
  broadcastStream = streamToSend;
  broadcastStream.getTracks().forEach(t => pc.addTrack(t, broadcastStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
  
  isStreaming = true;
  startStreamBtn.textContent = "Live Streaming 🔴";
  startStreamBtn.classList.add('danger');
  hangupBtn.disabled = false;
}
if (startStreamBtn) startStreamBtn.addEventListener('click', startBroadcast);
socket.on('webrtc-answer', async ({ sdp }) => { if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp)); });
socket.on('webrtc-ice-candidate', async ({ candidate }) => { if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate)); });

// Toggles
if (toggleCamBtn) toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    track.enabled = !track.enabled;
    toggleCamBtn.textContent = track.enabled ? 'Camera Off' : 'Camera On';
    toggleCamBtn.classList.toggle('danger', !track.enabled);
});
if (toggleMicBtn) toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    toggleMicBtn.textContent = track.enabled ? 'Mute' : 'Unmute';
    toggleMicBtn.classList.toggle('danger', !track.enabled);
});
if (shareScreenBtn) shareScreenBtn.addEventListener('click', async () => {
    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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

if (hangupBtn) hangupBtn.addEventListener('click', () => {
    if (isStreaming) {
      if (pc) pc.close();
      pc = null; isStreaming = false;
      startStreamBtn.textContent = 'Start Stream';
      startStreamBtn.classList.remove('danger');
    }
    stopScreenShare();
    Object.keys(callPeers).forEach(id => endPeerCall(id));
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject = null;
    hangupBtn.disabled = true;
    setTimeout(startLocalMedia, 1000);
});

// --- CHAT LOGIC ---
function appendChat(targetLog, name, text, ts) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const t = new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  line.innerHTML = `<strong>${name}</strong> <small>${t}</small>: ${text}`;
  targetLog.appendChild(line);
  targetLog.scrollTop = targetLog.scrollHeight;
}

socket.on('public-chat', (d) => {
    appendChat(chatLogPublic, d.name, d.text, d.ts);
    if (activeChatMode !== 'public') btnPublicChat.classList.add('has-new');
});
socket.on('private-chat', (d) => {
    appendChat(chatLogPrivate, d.name, d.text, d.ts);
    if (activeChatMode !== 'private') btnPrivateChat.classList.add('has-new');
});

if (sendBtn) sendBtn.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if(!text) return;
    if (activeChatMode === 'public') {
        socket.emit('public-chat', { room: currentRoom, name: userName, text });
    } else {
        socket.emit('private-chat', { room: currentRoom, name: userName, text });
    }
    chatInput.value = '';
});

// Utils
if (emojiStrip) {
  emojiStrip.addEventListener('click', (e) => {
    if (e.target.classList.contains('emoji')) {
      chatInput.value += e.target.textContent;
      chatInput.focus();
    }
  });
}
function renderUserList(users, ownerId) {
  userList.innerHTML = '';
  users.forEach(u => {
      if (u.id === myId) return;
      const div = document.createElement('div');
      div.className = 'user-item';
      div.dataset.userid = u.id;
      div.dataset.username = u.name;
      div.innerHTML = `<span>${u.id === ownerId ? '👑' : ''} ${u.name}</span>
        <div class="user-actions">
           <button onclick="ringUser('${u.id}')" class="action-btn ring">📞 Call</button>
           ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
        </div>`;
      userList.appendChild(div);
  });
}
window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);
