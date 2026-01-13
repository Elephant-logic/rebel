// REBEL MESSENGER - FINAL FIXED VERSION
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let activeChatMode = 'public';

// GLOBAL DATA
let latestUserList = []; // Cache to re-render buttons
let currentOwnerId = null;

// MEDIA
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false;

// PEER CONNECTIONS
const viewerPeers = {}; 
const callPeers = {}; 
const remoteStreams = {};

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM
const $ = id => document.getElementById(id);

// --- SETTINGS LOGIC ---
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

// --- MEDIA START ---
async function startLocalMedia() {
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
    } catch(e) { 
        console.error(e); 
        alert("Camera Error. Check permissions."); 
    }
}

// --- STREAMING (HOST -> VIEWERS) ---
if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) return alert("Host only");
        
        if (!localStream) await startLocalMedia();
        isStreaming = true;
        $('startStreamBtn').textContent = "Live 🔴";
        $('startStreamBtn').classList.add('danger');
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
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => {
    const pc = viewerPeers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});
socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
    const pc = viewerPeers[from];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});
socket.on('user-left', ({ id }) => {
    if (viewerPeers[id]) { viewerPeers[id].close(); delete viewerPeers[id]; }
    endPeerCall(id, true);
});

// --- CALLING (P2P) ---
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
    
    renderUserList(); // Update buttons
}

function endPeerCall(id, isIncomingSignal) {
  if (callPeers[id]) { try { callPeers[id].pc.close(); } catch(e){} }
  delete callPeers[id];
  delete remoteStreams[id];
  removeRemoteVideo(id);
  if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
  renderUserList(); // Update buttons
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

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}

if ($('updateSlugBtn')) {
    $('updateSlugBtn').addEventListener('click', () => {
        const slug = $('slugInput').value.trim();
        if (slug) updateLink(slug);
    });
}

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    // Cache data for re-renders
    latestUserList = users;
    currentOwnerId = ownerId;
    
    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
        $('lockRoomBtn').onclick = () => { if(iAmHost) socket.emit('lock-room', !locked); };
    }
    renderUserList();
});

socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});

// --- CHAT LOGIC ---
const chatPublic = $('chatLogPublic');
const chatPrivate = $('chatLogPrivate');
const btnPublic = $('btnPublicChat');
const btnPrivate = $('btnPrivateChat');

function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    d.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text}`;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

socket.on('public-chat', d => {
    appendChat(chatPublic, d.name, d.text, d.ts);
    if(activeChatMode !== 'public') btnPublic.classList.add('has-new');
});
socket.on('private-chat', d => {
    appendChat(chatPrivate, d.name, d.text, d.ts);
    if(activeChatMode !== 'private') btnPrivate.classList.add('has-new');
});

$('sendBtn').addEventListener('click', () => {
    const text = $('chatInput').value.trim();
    if(!text) return;
    const evt = activeChatMode === 'public' ? 'public-chat' : 'private-chat';
    socket.emit(evt, { room: currentRoom, name: userName, text });
    $('chatInput').value = '';
});

btnPublic.onclick = () => {
    activeChatMode = 'public';
    btnPublic.classList.add('active'); btnPrivate.classList.remove('active');
    chatPublic.style.display = 'block'; chatPrivate.style.display = 'none';
    btnPublic.classList.remove('has-new');
};
btnPrivate.onclick = () => {
    activeChatMode = 'private';
    btnPrivate.classList.add('active'); btnPublic.classList.remove('active');
    chatPrivate.style.display = 'block'; chatPublic.style.display = 'none';
    btnPrivate.classList.remove('has-new');
};

// --- RENDER USER LIST (FIXED) ---
function renderUserList() {
    const list = $('userList'); 
    if(!list) return;
    list.innerHTML = '';
    
    if (!latestUserList) return;

    latestUserList.forEach(u => {
        if (u.id === myId) return;
        
        const div = document.createElement('div');
        div.className = 'user-item';
        
        // Dynamic Call/End Button
        const isCalling = !!callPeers[u.id];
        let actionBtn = '';
        
        if (isCalling) {
             actionBtn = `<button onclick="endPeerCall('${u.id}')" class="action-btn" style="border-color:var(--danger); color:var(--danger)">End Call</button>`;
        } else {
             actionBtn = `<button onclick="callPeer('${u.id}')" class="action-btn">📞 Call</button>`;
        }
        
        // Kick Button (Host Only)
        const kickBtn = iAmHost 
            ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` 
            : '';

        div.innerHTML = `
            <span>${u.id === currentOwnerId ? '👑' : ''} ${u.name}</span> 
            <div class="user-actions">
                ${actionBtn}
                ${kickBtn}
            </div>
        `;
        list.appendChild(div);
    });
}

// --- HELPERS & EXPORTS ---
function addRemoteVideo(id, stream) {
    const d = document.createElement('div');
    d.className = 'video-container'; d.id = `vid-${id}`;
    d.innerHTML = `<video autoplay playsinline></video>`;
    d.querySelector('video').srcObject = stream;
    $('videoGrid').appendChild(d);
}
function removeRemoteVideo(id) {
    const el = document.getElementById(`vid-${id}`);
    if(el) el.remove();
}

// Make functions available to HTML onclick events
window.callPeer = callPeer;
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);
window.ringUser = (id) => socket.emit('ring-user', id);

if ($('openStreamBtn')) $('openStreamBtn').addEventListener('click', () => {
   const url = $('streamLinkInput').value;
   if(url) window.open(url, '_blank');
});
