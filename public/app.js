// ==================================================================
// REBEL MESSENGER CLIENT - COMPLETE
// ==================================================================
const socket = io({ autoConnect: false });

// ------------------------------------------------------------------
// GLOBAL STATE
// ------------------------------------------------------------------
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// Media State
let localStream = null;
let isScreenSharing = false;
let screenStream = null;

// Streaming State (Host -> Viewers)
let pc = null; 
let isStreaming = false;
let broadcastStream = null;

// Calling State (P2P Mesh)
// callPeers[socketId] = { pc: RTCPeerConnection, name: string, iceQueue: [] }
const callPeers = {}; 

// ICE Configuration
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ------------------------------------------------------------------
// DOM ELEMENTS
// ------------------------------------------------------------------
const $ = id => document.getElementById(id);

// Inputs & Buttons
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

// Media Controls
const startStreamBtn  = $('startStreamBtn');
const streamQuality   = $('streamQuality'); 
const hangupBtn       = $('hangupBtn'); 
const shareScreenBtn  = $('shareScreenBtn');
const toggleCamBtn    = $('toggleCamBtn');
const toggleMicBtn    = $('toggleMicBtn');
const settingsBtn     = $('settingsBtn');
const openStreamBtn   = $('openStreamBtn');
const streamLinkInput = $('streamLinkInput');

// Settings Panel
const settingsPanel   = $('settingsPanel');
const audioSource     = $('audioSource');
const videoSource     = $('videoSource');
const closeSettingsBtn= $('closeSettingsBtn');

// Tabs
const tabChatBtn      = $('tabChatBtn');
const tabFilesBtn     = $('tabFilesBtn');
const tabUsersBtn     = $('tabUsersBtn');
const tabContentChat  = $('tabContentChat');
const tabContentFiles = $('tabContentFiles');
const tabContentUsers = $('tabContentUsers');

// Chat & Files
const chatLog         = $('chatLog');
const chatInput       = $('chatInput');
const sendBtn         = $('sendBtn');
const emojiStrip      = $('emojiStrip');
const fileInput       = $('fileInput');
const sendFileBtn     = $('sendFileBtn');
const fileLog         = $('fileLog');
const fileNameLabel   = $('fileNameLabel');
const userList        = $('userList');
const videoGrid       = $('videoGrid');
const localVideo      = $('localVideo');

// ------------------------------------------------------------------
// TAB NAVIGATION
// ------------------------------------------------------------------
function switchTab(name) {
  [tabChatBtn, tabFilesBtn, tabUsersBtn].forEach(b => b && b.classList.remove('active'));
  [tabContentChat, tabContentFiles, tabContentUsers].forEach(c => c && c.classList.remove('active'));

  if (name === 'chat') {
    if(tabChatBtn) tabChatBtn.classList.add('active');
    if(tabContentChat) tabContentChat.classList.add('active');
  } else if (name === 'files') {
    if(tabFilesBtn) tabFilesBtn.classList.add('active');
    if(tabContentFiles) tabContentFiles.classList.add('active');
  } else if (name === 'users') {
    if(tabUsersBtn) tabUsersBtn.classList.add('active');
    if(tabContentUsers) tabContentUsers.classList.add('active');
  }
}

if(tabChatBtn) tabChatBtn.addEventListener('click', () => switchTab('chat'));
if(tabFilesBtn) tabFilesBtn.addEventListener('click', () => switchTab('files'));
if(tabUsersBtn) tabUsersBtn.addEventListener('click', () => switchTab('users'));


// ------------------------------------------------------------------
// MEDIA & DEVICE MANAGEMENT
// ------------------------------------------------------------------
async function getMedia(constraints) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch(e) {
    console.error("Media Error:", e);
    alert("Could not access Camera/Mic. Please check browser permissions.");
    return null;
  }
}

async function getDevices() {
  try {
    // Request permission momentarily to get labels
    const tempStream = await navigator.mediaDevices.getUserMedia({audio:true, video:true}).catch(e=>{});
    if(tempStream) tempStream.getTracks().forEach(t=>t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audios = devices.filter(d => d.kind === 'audioinput');
    const videos = devices.filter(d => d.kind === 'videoinput');

    if (audioSource) {
      const cur = audioSource.value;
      audioSource.innerHTML = audios.map(d => `<option value="${d.deviceId}">${d.label || 'Mic '+d.deviceId.slice(0,4)}</option>`).join('');
      if(cur) audioSource.value = cur;
    }
    if (videoSource) {
      const cur = videoSource.value;
      videoSource.innerHTML = videos.map(d => `<option value="${d.deviceId}">${d.label || 'Cam '+d.deviceId.slice(0,4)}</option>`).join('');
      if(cur) videoSource.value = cur;
    }
  } catch(e) { console.error(e); }
}

async function switchMedia() {
  // Stop current local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }

  const aId = audioSource ? audioSource.value : undefined;
  const vId = videoSource ? videoSource.value : undefined;

  const constraints = {
    audio: aId ? { deviceId: { exact: aId } } : true,
    video: vId ? { deviceId: { exact: vId } } : true
  };

  localStream = await getMedia(constraints);
  
  if (localStream) {
    if(localVideo) {
      localVideo.srcObject = localStream;
      localVideo.muted = true; 
    }

    // UPDATE ACTIVE CONNECTIONS (HOT SWAP)
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];

    // Helper
    const replace = (peerConn) => {
      if(!peerConn) return;
      const senders = peerConn.getSenders();
      const vSender = senders.find(s => s.track && s.track.kind === 'video');
      const aSender = senders.find(s => s.track && s.track.kind === 'audio');
      if(vSender && vTrack) vSender.replaceTrack(vTrack).catch(e=>{});
      if(aSender && aTrack) aSender.replaceTrack(aTrack).catch(e=>{});
    };

    // Update Stream PC
    if (isStreaming && pc && !isScreenSharing) {
       replace(pc);
    }

    // Update P2P Calls
    Object.values(callPeers).forEach(peer => replace(peer.pc));
  }
}

async function ensureLocalStream() {
  if (localStream && localStream.active) return localStream;
  await switchMedia();
  return localStream;
}

if(settingsBtn) settingsBtn.addEventListener('click', async () => {
  if (settingsPanel.style.display === 'none') {
    settingsPanel.style.display = 'block';
    await getDevices();
  } else {
    settingsPanel.style.display = 'none';
  }
});

if(closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => {
  settingsPanel.style.display = 'none';
  switchMedia();
});


// ------------------------------------------------------------------
// VIDEO GRID HELPERS
// ------------------------------------------------------------------
function addRemoteVideo(id, stream, name) {
  if (!videoGrid) return;
  
  let div = document.getElementById(`vid-${id}`);
  if (!div) {
    div = document.createElement('div');
    div.id = `vid-${id}`;
    div.className = 'video-container';
    div.innerHTML = `<h2>${name}</h2><video autoplay playsinline></video>`;
    videoGrid.appendChild(div);
  }
  const video = div.querySelector('video');
  video.srcObject = stream;
}

function removeRemoteVideo(id) {
  const div = document.getElementById(`vid-${id}`);
  if (div) div.remove();
}


// ------------------------------------------------------------------
// HOST STREAMING (One-to-Many Broadcast)
// ------------------------------------------------------------------
if(startStreamBtn) startStreamBtn.addEventListener('click', async () => {
  if (!iAmHost) return alert("Only the Host can stream.");
  
  if (pc) { pc.close(); pc = null; }
  pc = new RTCPeerConnection(iceConfig);

  // Check Quality / Mode
  const mode = streamQuality ? streamQuality.value : '720';
  let streamToSend = null;

  if (mode === 'screen') {
    try {
      streamToSend = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
      isScreenSharing = true;
    } catch(e) { return; } // cancelled
  } else {
    // Camera
    const height = parseInt(mode) || 720;
    await ensureLocalStream();
    streamToSend = localStream;
    // Try to apply constraint
    try {
       const t = streamToSend.getVideoTracks()[0];
       if(t) await t.applyConstraints({height:{ideal:height}});
    } catch(e){}
    isScreenSharing = false;
  }
  
  broadcastStream = streamToSend;
  broadcastStream.getTracks().forEach(t => pc.addTrack(t, broadcastStream));

  // ICE
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };

  // OFFER
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });

  // UI
  isStreaming = true;
  startStreamBtn.textContent = 'Live Streaming';
  startStreamBtn.classList.add('danger');
  if(hangupBtn) hangupBtn.disabled = false;
});

// STREAM HANDSHAKE
socket.on('webrtc-answer', async (d) => {
  if (pc) {
    try { await pc.setRemoteDescription(new RTCSessionDescription(d.sdp)); } catch(e){}
  }
});
socket.on('webrtc-ice-candidate', async (d) => {
  if (pc) {
    try { await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch(e){}
  }
});


// ------------------------------------------------------------------
// P2P CALLING (Mesh Network)
// ------------------------------------------------------------------
function createPeer(targetId, name) {
  const cp = new RTCPeerConnection(iceConfig);
  callPeers[targetId] = { pc: cp, name: name, iceQueue: [] };

  cp.onicecandidate = e => {
    if(e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate });
  };

  cp.ontrack = e => {
    addRemoteVideo(targetId, e.streams[0], name);
  };
  return cp;
}

async function startCall(targetId) {
  const stream = await ensureLocalStream();
  if(!stream) return;

  // Get name from DOM
  const el = document.querySelector(`[data-userid="${targetId}"]`);
  const name = el ? el.dataset.username : 'Peer';

  const cp = createPeer(targetId, name);
  stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const offer = await cp.createOffer();
  await cp.setLocalDescription(offer);
  
  socket.emit('call-offer', { targetId, offer });
  
  updateUserButton(targetId, true);
}

function endPeerCall(id, fromRemote=false) {
  const p = callPeers[id];
  if (p && p.pc) p.pc.close();
  delete callPeers[id];
  removeRemoteVideo(id);

  if (!fromRemote) socket.emit('call-end', { targetId: id });
  
  updateUserButton(id, false);
}
window.endPeerCall = endPeerCall; // Global

// P2P SOCKET EVENTS
socket.on('ring-alert', ({ from, fromId }) => {
  if(confirm(`Incoming call from ${from}. Accept?`)) {
    startCall(fromId);
  }
});

socket.on('incoming-call', async ({ from, name, offer }) => {
  const stream = await ensureLocalStream();
  const cp = createPeer(from, name);
  
  await cp.setRemoteDescription(new RTCSessionDescription(offer));
  if(stream) stream.getTracks().forEach(t => cp.addTrack(t, stream));

  const ans = await cp.createAnswer();
  await cp.setLocalDescription(ans);

  socket.emit('call-answer', { targetId: from, answer: ans });

  // Flush ICE
  const p = callPeers[from];
  if(p.iceQueue.length) {
    p.iceQueue.forEach(c => cp.addIceCandidate(c));
    p.iceQueue = [];
  }
  updateUserButton(from, true);
});

socket.on('call-answer', async ({ from, answer }) => {
  const p = callPeers[from];
  if (p && p.pc) {
    await p.pc.setRemoteDescription(new RTCSessionDescription(answer));
    p.iceQueue.forEach(c => p.pc.addIceCandidate(c));
    p.iceQueue = [];
  }
});

socket.on('call-ice', ({ from, candidate }) => {
  const p = callPeers[from];
  if(p && p.pc) {
    if(p.pc.remoteDescription) p.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e=>{});
    else p.iceQueue.push(new RTCIceCandidate(candidate));
  }
});

socket.on('call-end', ({ from }) => endPeerCall(from, true));


// ------------------------------------------------------------------
// FILE SHARING (FULL)
// ------------------------------------------------------------------
if (fileInput) fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (f) {
    fileNameLabel.textContent = f.name;
    sendFileBtn.disabled = false;
  } else {
    fileNameLabel.textContent = "No file selected";
    sendFileBtn.disabled = true;
  }
});

if (sendFileBtn) sendFileBtn.addEventListener('click', () => {
  const f = fileInput.files[0];
  if(!f) return;
  // Limit 50MB
  if(f.size > 50*1024*1024) return alert("File too large (>50MB)");

  const reader = new FileReader();
  reader.onload = (e) => {
    socket.emit('file-share', {
      room: currentRoom,
      name: userName,
      fileName: f.name,
      fileType: f.type,
      fileData: e.target.result
    });
    appendFile('You', f.name, e.target.result);
    fileInput.value = '';
    fileNameLabel.textContent = "Sent!";
    sendFileBtn.disabled = true;
  };
  reader.readAsDataURL(f);
});

socket.on('file-share', d => appendFile(d.name, d.fileName, d.fileData));

function appendFile(sender, fname, data) {
  if(!fileLog) return;
  const div = document.createElement('div');
  div.className = 'file-item';
  div.innerHTML = `<div><strong>${sender}</strong>: ${fname}</div><a href="${data}" download="${fname}" class="btn small">Download</a>`;
  fileLog.appendChild(div);
}


// ------------------------------------------------------------------
// CHAT & UTILS
// ------------------------------------------------------------------
function appendChat(name, text) {
  if(!chatLog) return;
  const div = document.createElement('div');
  div.className = 'chat-line';
  div.innerHTML = `<strong>${name}:</strong> ${text}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

if(sendBtn) sendBtn.addEventListener('click', () => {
  const t = chatInput.value.trim();
  if(t) {
    socket.emit('chat-message', { room: currentRoom, name: userName, text: t });
    chatInput.value = '';
  }
});

if(emojiStrip) emojiStrip.addEventListener('click', e => {
  if(e.target.classList.contains('emoji')) {
    chatInput.value += e.target.textContent;
    chatInput.focus();
  }
});

socket.on('chat-message', d => appendChat(d.name, d.text));


// ------------------------------------------------------------------
// GLOBAL SOCKET EVENTS
// ------------------------------------------------------------------
socket.on('connect', () => {
  if(signalStatus) {
     signalStatus.textContent = "Connected";
     signalStatus.className = "status-dot status-connected";
  }
  myId = socket.id;
});

socket.on('disconnect', () => {
  if(signalStatus) {
     signalStatus.textContent = "Disconnected";
     signalStatus.className = "status-dot status-disconnected";
  }
});

socket.on('user-joined', d => appendChat('System', `${d.name} joined.`));
socket.on('user-left', d => endPeerCall(d.id, true));
socket.on('kicked', () => { alert("You have been kicked."); window.location.reload(); });

socket.on('room-update', d => {
  // Update Role
  iAmHost = (d.ownerId === myId);
  if(hostControls) hostControls.style.display = iAmHost ? 'block' : 'none';
  
  if(iAmHost) {
      if(streamTitleInput) streamTitleInput.value = d.streamTitle || '';
      if(slugInput) slugInput.value = d.publicSlug || '';
  }

  // Update Link
  if(streamLinkInput) {
      const id = d.publicSlug || currentRoom;
      const url = new URL(window.location.href);
      url.pathname = url.pathname.replace('index.html', '') + 'view.html';
      url.search = `?room=${encodeURIComponent(id)}`;
      streamLinkInput.value = url.toString();
  }

  // Lock Btn
  if(lockRoomBtn) lockRoomBtn.textContent = d.locked ? "🔒 Unlock Room" : "🔓 Lock Room";

  // User List
  if(userList) {
      userList.innerHTML = '';
      d.users.forEach(u => {
          if(u.id === myId) return;
          const inCall = !!callPeers[u.id];
          const div = document.createElement('div');
          div.className = 'user-item';
          div.dataset.userid = u.id;
          div.dataset.username = u.name;
          div.innerHTML = `
            <span>${u.id === d.ownerId ? '👑' : ''} ${u.name}</span>
            <div class="user-actions">
               <button onclick="${inCall ? `endPeerCall('${u.id}')` : `ringUser('${u.id}')`}" class="${inCall?'action-btn danger':'action-btn'}">${inCall?'End':'📞 Call'}</button>
               ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
            </div>
          `;
          userList.appendChild(div);
      });
  }
});

socket.on('role', d => {
  iAmHost = d.isHost;
  if(iAmHost && hostControls) hostControls.style.display = 'block';
});


// ------------------------------------------------------------------
// GLOBAL BUTTON ACTIONS
// ------------------------------------------------------------------
if(joinBtn) joinBtn.addEventListener('click', () => {
  const r = roomInput.value.trim();
  const n = nameInput.value.trim();
  if(!r) return alert("Room ID required");
  currentRoom = r;
  userName = n || 'Anon';
  
  socket.connect();
  socket.emit('join-room', { room: r, name: userName });
  
  joinBtn.disabled = true;
  if(leaveBtn) leaveBtn.disabled = false;
  if(roomInfo) roomInfo.textContent = `Room: ${r}`;
  ensureLocalStream();
});

if(leaveBtn) leaveBtn.addEventListener('click', () => location.reload());

if(updateTitleBtn) updateTitleBtn.addEventListener('click', () => socket.emit('update-stream-title', streamTitleInput.value));
if(updateSlugBtn) updateSlugBtn.addEventListener('click', () => socket.emit('update-public-slug', slugInput.value));
if(lockRoomBtn) lockRoomBtn.addEventListener('click', () => socket.emit('lock-room', true));

if(openStreamBtn) openStreamBtn.addEventListener('click', () => {
    if(streamLinkInput.value) window.open(streamLinkInput.value, '_blank');
});

if(hangupBtn) hangupBtn.addEventListener('click', () => {
    // Hangup Everything
    if(isStreaming && pc) { pc.close(); pc=null; isStreaming=false; startStreamBtn.textContent='Start Stream'; startStreamBtn.classList.remove('danger'); }
    if(isScreenSharing) { if(screenStream) screenStream.getTracks().forEach(t=>t.stop()); isScreenSharing=false; shareScreenBtn.textContent="Share Screen"; shareScreenBtn.classList.remove('danger'); }
    
    Object.keys(callPeers).forEach(id => endPeerCall(id));
    hangupBtn.disabled = true;
});

// Toggles
if(toggleCamBtn) toggleCamBtn.addEventListener('click', () => {
   if(localStream) {
       const t = localStream.getVideoTracks()[0];
       if(t) { t.enabled = !t.enabled; toggleCamBtn.textContent = t.enabled ? "Cam Off" : "Cam On"; }
   }
});
if(toggleMicBtn) toggleMicBtn.addEventListener('click', () => {
   if(localStream) {
       const t = localStream.getAudioTracks()[0];
       if(t) { t.enabled = !t.enabled; toggleMicBtn.textContent = t.enabled ? "Mute" : "Unmute"; }
   }
});

// Screen Share Toggle
if(shareScreenBtn) shareScreenBtn.addEventListener('click', async () => {
   if(!isScreenSharing) {
       try {
           screenStream = await navigator.mediaDevices.getDisplayMedia({video:true, audio:true});
           isScreenSharing = true;
           shareScreenBtn.textContent = "Stop Screen";
           shareScreenBtn.classList.add('danger');
           
           // Local View
           if(localVideo) localVideo.srcObject = screenStream;
           
           const trk = screenStream.getVideoTracks()[0];
           trk.onended = () => { /* Handle Stop via browser UI */ };

           // Replace in Stream
           if(isStreaming && pc) {
               const s = pc.getSenders().find(s=>s.track.kind==='video');
               if(s) s.replaceTrack(trk);
           }
           // Replace in Calls
           Object.values(callPeers).forEach(p => {
               const s = p.pc.getSenders().find(s=>s.track.kind==='video');
               if(s) s.replaceTrack(trk);
           });
       } catch(e){}
   } else {
       if(screenStream) screenStream.getTracks().forEach(t=>t.stop());
       isScreenSharing = false;
       shareScreenBtn.textContent = "Share Screen";
       shareScreenBtn.classList.remove('danger');
       
       if(localVideo) localVideo.srcObject = localStream;
       if(localStream) {
           const trk = localStream.getVideoTracks()[0];
           if(isStreaming && pc) {
               const s = pc.getSenders().find(s=>s.track.kind==='video');
               if(s) s.replaceTrack(trk);
           }
           Object.values(callPeers).forEach(p => {
               const s = p.pc.getSenders().find(s=>s.track.kind==='video');
               if(s) s.replaceTrack(trk);
           });
       }
   }
});

// Global Helpers
window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);

// Helper to update button state in UI
function updateUserButton(id, inCall) {
   const el = document.querySelector(`[data-userid="${id}"]`);
   if(el) {
       const btn = el.querySelector('button');
       if(btn) {
           btn.textContent = inCall ? 'End' : '📞 Call';
           btn.className = inCall ? 'action-btn danger' : 'action-btn';
           btn.setAttribute('onclick', inCall ? `endPeerCall('${id}')` : `ringUser('${id}')`);
       }
   }
}
