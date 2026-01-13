import { pushFileToPeer } from './side-loader.js';

// REBEL MESSENGER - SECURE VERSION
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// GLOBAL DATA
let latestUserList = [];
let currentOwnerId = null;

// MEDIA
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false;

// ARCADE STATE
let activeToolboxFile = null;

// PEER CONNECTIONS
const viewerPeers = {}; 
const callPeers = {}; 

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const $ = id => document.getElementById(id);

// --- TABS LOGIC ---
const tabs = {
    stream: $('tabStreamChat'),
    room: $('tabRoomChat'),
    files: $('tabFiles'),
    users: $('tabUsers')
};
const contents = {
    stream: $('contentStreamChat'),
    room: $('contentRoomChat'),
    files: $('contentFiles'),
    users: $('contentUsers')
};

function switchTab(name) {
    if(!tabs[name]) return;
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));
    tabs[name].classList.add('active');
    contents[name].classList.add('active');
    tabs[name].classList.remove('has-new');
}

if(tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if(tabs.room) tabs.room.onclick = () => switchTab('room');
if(tabs.files) tabs.files.onclick = () => switchTab('files');
if(tabs.users) tabs.users.onclick = () => switchTab('users');

// --- SETTINGS ---
const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const videoSource = $('videoSource');

if ($('settingsBtn')) {
    $('settingsBtn').addEventListener('click', () => {
        const isHidden = settingsPanel.style.display === 'none' || settingsPanel.style.display === '';
        settingsPanel.style.display = isHidden ? 'block' : 'none';
        if (isHidden) getDevices();
    });
}
if ($('closeSettingsBtn')) $('closeSettingsBtn').addEventListener('click', () => settingsPanel.style.display = 'none');

async function getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        audioSource.innerHTML = ''; videoSource.innerHTML = '';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0,5)}`;
            if (d.kind === 'audioinput') audioSource.appendChild(opt);
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at) audioSource.value = at.getSettings().deviceId;
            if (vt) videoSource.value = vt.getSettings().deviceId;
        }
    } catch(e) { console.error(e); }
}
audioSource.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;

// --- MEDIA FUNCTIONS ---
async function startLocalMedia() {
    if (isScreenSharing) return;

    if (localStream) localStream.getTracks().forEach(t => t.stop());
    const constraints = {
        audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
        video: { deviceId: videoSource.value ? { exact: videoSource.value } : undefined }
    };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true;
        
        const tracks = localStream.getTracks();
        const updatePC = (pc) => {
             if(!pc) return;
             const senders = pc.getSenders();
             tracks.forEach(t => {
                 const sender = senders.find(s => s.track && s.track.kind === t.kind);
                 if(sender) sender.replaceTrack(t);
             });
        };
        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));

        $('hangupBtn').disabled = false;
        updateMediaButtons();
    } catch(e) { console.error(e); alert("Camera Error. Check permissions."); }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];
    
    if($('toggleCamBtn')) {
        $('toggleCamBtn').textContent = (vTrack && vTrack.enabled) ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !(vTrack && vTrack.enabled));
    }
    if($('toggleMicBtn')) {
        $('toggleMicBtn').textContent = (aTrack && aTrack.enabled) ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !(aTrack && aTrack.enabled));
    }
}

if ($('toggleMicBtn')) {
    $('toggleMicBtn').addEventListener('click', () => {
        if (!localStream) return;
        const track = localStream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        updateMediaButtons();
    });
}

if ($('toggleCamBtn')) {
    $('toggleCamBtn').addEventListener('click', () => {
        if (!localStream) return;
        const track = localStream.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        updateMediaButtons();
    });
}

if ($('shareScreenBtn')) {
    $('shareScreenBtn').addEventListener('click', async () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                isScreenSharing = true;
                $('shareScreenBtn').textContent = 'Stop Screen';
                $('shareScreenBtn').classList.add('danger');
                $('localVideo').srcObject = screenStream;
                const screenTrack = screenStream.getVideoTracks()[0];
                const updatePC = (pc) => {
                     if(!pc) return;
                     const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                     if(sender) sender.replaceTrack(screenTrack);
                };
                Object.values(viewerPeers).forEach(updatePC);
                Object.values(callPeers).forEach(p => updatePC(p.pc));
                screenTrack.onended = stopScreenShare;
            } catch(e) { console.error(e); }
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    isScreenSharing = false;
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    $('localVideo').srcObject = localStream;
    if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        const updatePC = (pc) => {
             if(!pc) return;
             const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
             if(sender) sender.replaceTrack(camTrack);
        };
        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));
    }
}

// --- STREAMING (HOST) ---
if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) return alert("Host only");
        if (isStreaming) {
            isStreaming = false;
            $('startStreamBtn').textContent = "Start Stream";
            $('startStreamBtn').classList.remove('danger');
            Object.values(viewerPeers).forEach(pc => pc.close());
            for (const k in viewerPeers) delete viewerPeers[k];
            return;
        }
        if (!localStream) await startLocalMedia();
        isStreaming = true;
        $('startStreamBtn').textContent = "Stop Stream"; 
        $('startStreamBtn').classList.add('danger');
        latestUserList.forEach(u => {
            if(u.id !== myId) connectViewer(u.id);
        });
    });
}

socket.on('user-joined', ({ id, name }) => {
    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
});

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); };
    
    const stream = isScreenSharing ? screenStream : localStream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    
    // ARCADE PUSH
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing tool to ${targetId}`);
        pushFileToPeer(pc, activeToolboxFile, null); 
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => {
    if (viewerPeers[from]) await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp));
});
socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
    if (viewerPeers[from]) await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate));
});
socket.on('user-left', ({ id }) => {
    if (viewerPeers[id]) { viewerPeers[id].close(); delete viewerPeers[id]; }
    endPeerCall(id, true);
});

// --- CALLING (P2P) ---
socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`Incoming call from ${from}. Accept?`)) await callPeer(fromId);
});

async function callPeer(targetId) {
    if (!localStream) await startLocalMedia();
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, name: "Peer" };
    pc.onicecandidate = e => { if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate }); };
    pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call-offer', { targetId, offer });
    renderUserList();
}

socket.on('incoming-call', async ({ from, name, offer }) => {
    if (!localStream) await startLocalMedia();
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[from] = { pc, name };
    pc.onicecandidate = e => { if (e.candidate) socket.emit('call-ice', { targetId: from, candidate: e.candidate }); };
    pc.ontrack = e => addRemoteVideo(from, e.streams[0]);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call-answer', { targetId: from, answer });
    renderUserList();
});

socket.on('call-answer', async ({ from, answer }) => {
    if (callPeers[from]) await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer));
});
socket.on('call-ice', ({ from, candidate }) => {
    if (callPeers[from]) callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate));
});
socket.on('call-end', ({ from }) => endPeerCall(from, true));

function endPeerCall(id, isIncomingSignal) {
  if (callPeers[id]) { try { callPeers[id].pc.close(); } catch(e){} }
  delete callPeers[id];
  removeRemoteVideo(id);
  if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
  renderUserList();
}

// --- SOCKET CORE ---
socket.on('connect', () => { $('signalStatus').className = 'status-dot status-connected'; $('signalStatus').textContent = 'Connected'; myId = socket.id; });
socket.on('disconnect', () => { $('signalStatus').className = 'status-dot status-disconnected'; $('signalStatus').textContent = 'Disconnected'; });

$('joinBtn').addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    if (!room) return;
    currentRoom = room; userName = $('nameInput').value.trim() || 'Host';
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    $('joinBtn').disabled = true; $('leaveBtn').disabled = false;
    updateLink(room);
    startLocalMedia();
});

if ($('leaveBtn')) {
    $('leaveBtn').addEventListener('click', () => {
        window.location.reload();
    });
}

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}
if ($('updateSlugBtn')) $('updateSlugBtn').addEventListener('click', () => {
    const slug = $('slugInput').value.trim();
    if (slug) updateLink(slug);
});

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users;
    currentOwnerId = ownerId;
    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? 'Unlock Room' : 'Lock Room';
        $('lockRoomBtn').onclick = () => { if(iAmHost) socket.emit('lock-room', !locked); };
    }
    renderUserList();
});

socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    const localContainer = $('localContainer');
    if (localContainer) {
        localContainer.querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    }
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});

// --- CHAT LOGIC (SECURITY FIX APPLIED) ---
function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    
    // SECURITY FIX: Create DOM elements, don't use innerHTML for user text
    const nameSpan = document.createElement('strong');
    nameSpan.textContent = name;
    
    const timeSpan = document.createElement('small');
    timeSpan.textContent = new Date(ts).toLocaleTimeString();
    
    const textNode = document.createTextNode(`: ${text}`);
    
    d.appendChild(nameSpan);
    d.appendChild(document.createTextNode(' '));
    d.appendChild(timeSpan);
    d.appendChild(textNode);
    
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

// PUBLIC CHAT
function sendPublic() {
    const inp = $('inputPublic');
    const text = inp.value.trim();
    if(!text) return;
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPublic').addEventListener('click', sendPublic);
$('inputPublic').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPublic(); });

socket.on('public-chat', d => {
    appendChat($('chatLogPublic'), d.name, d.text, d.ts);
    if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new');
});

// PRIVATE CHAT
function sendPrivate() {
    const inp = $('inputPrivate');
    const text = inp.value.trim();
    if(!text) return;
    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPrivate').addEventListener('click', sendPrivate);
$('inputPrivate').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPrivate(); });

socket.on('private-chat', d => {
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts);
    if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new');
});

// EMOJI
const emojiStripPublic = $('emojiStripPublic');
const emojiStripPrivate = $('emojiStripPrivate');
if (emojiStripPublic) {
    emojiStripPublic.addEventListener('click', (e) => { if (e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; });
}
if (emojiStripPrivate) {
    emojiStripPrivate.addEventListener('click', (e) => { if (e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; });
}

// --- FILE TAB LOGIC ---
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileLog = $('fileLog');
fileInput.addEventListener('change', () => { 
    if (fileInput.files.length > 0) { 
        if($('fileNameLabel')) $('fileNameLabel').textContent = fileInput.files[0].name; 
        sendFileBtn.disabled = false; 
    } 
});
sendFileBtn.addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        socket.emit('file-share', { room: currentRoom, name: userName, fileName: file.name, fileData: reader.result });
        fileInput.value = ''; 
        if($('fileNameLabel')) $('fileNameLabel').textContent = 'No file selected'; 
        sendFileBtn.disabled = true;
    };
    reader.readAsDataURL(file);
});
socket.on('file-share', ({ name, fileName, fileData }) => {
    const d = document.createElement('div'); d.className = 'file-item';
    d.innerHTML = `<div><strong>${name}</strong> shared: ${fileName}</div><a href="${fileData}" download="${fileName}" class="btn small primary">Download</a>`;
    fileLog.appendChild(d);
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});

// --- ARCADE LOGIC ---
const arcadeInput = $('arcadeInput');
const arcadeStatus = $('arcadeStatus');

if (arcadeInput) {
    arcadeInput.addEventListener('change', async () => {
        const file = arcadeInput.files[0];
        if (!file) return;
        activeToolboxFile = file; 
        arcadeStatus.textContent = `Active Tool: ${file.name}`;
        const peers = Object.values(viewerPeers);
        if (peers.length > 0) {
            console.log(`[Arcade] Syncing ${file.name} to ${peers.length} existing viewers...`);
            peers.forEach(pc => {
                pushFileToPeer(pc, file, (percent) => {
                     if(percent % 20 === 0) console.log(`[Sync] ${percent}%`);
                });
            });
        }
    });
}

// --- RENDER USER LIST ---
function renderUserList() {
    const list = $('userList'); 
    if(!list) return;
    list.innerHTML = '';
    if (!latestUserList) return;
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        const div = document.createElement('div'); div.className = 'user-item';
        const isCalling = !!callPeers[u.id];
        let actionBtn = isCalling ? `<button onclick="endPeerCall('${u.id}')" class="action-btn" style="border-color:var(--danger); color:var(--danger)">End Call</button>` : `<button onclick="ringUser('${u.id}')" class="action-btn">Call</button>`;
        const kickBtn = iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : '';
        div.innerHTML = `<span>${u.id === currentOwnerId ? '👑' : ''} ${u.name}</span><div class="user-actions">${actionBtn}${kickBtn}</div>`;
        list.appendChild(div);
    });
}
function addRemoteVideo(id, stream) {
    let existing = document.getElementById(`vid-${id}`);
    if (existing) { const vid = existing.querySelector('video'); if (vid && vid.srcObject !== stream) vid.srcObject = stream; return; }
    const d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`; d.innerHTML = `<video autoplay playsinline></video>`; d.querySelector('video').srcObject = stream; $('videoGrid').appendChild(d);
}
function removeRemoteVideo(id) { const el = document.getElementById(`vid-${id}`); if(el) el.remove(); }

window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);
if ($('openStreamBtn')) $('openStreamBtn').addEventListener('click', () => { const url = $('streamLinkInput').value; if(url) window.open(url, '_blank'); });
