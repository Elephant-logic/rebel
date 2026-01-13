// ==========================================
// 1. ARCADE / SIDE-LOADER ENGINE
// ==========================================
// This logic slices large files into 16KB chunks to send over WebRTC safely.

const CHUNK_SIZE = 16 * 1024; // 16KB
const MAX_BUFFER = 256 * 1024; // 256KB Buffer Limit

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;
    
    // Create the data channel specifically for the arcade
    const channel = pc.createDataChannel("side-load-pipe");
    
    channel.onopen = async () => {
        console.log(`[Arcade] Pipe open. Starting transfer of ${file.name}`);
        
        // 1. Send Metadata (JSON)
        const metadata = JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            mime: file.type
        });
        channel.send(metadata);

        // 2. Read File into Memory
        const buffer = await file.arrayBuffer();
        let offset = 0;

        // 3. Start Sending Loop
        const sendLoop = () => {
            // Check Backpressure (Don't overload the network)
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }

            // If channel closed mid-transfer, stop
            if (channel.readyState !== 'open') return;

            // Slice the chunk
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;

            // Calculate Progress
            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            // Next Loop or Finish
            if (offset < buffer.byteLength) {
                setTimeout(sendLoop, 0); // Release UI thread
            } else {
                console.log(`[Arcade] Transfer Complete: ${file.name}`);
                setTimeout(() => channel.close(), 1000); 
            }
        };
        sendLoop();
    };
}

// ==========================================
// 2. MAIN APPLICATION LOGIC
// ==========================================

console.log("Rebel Stream Host App Loaded"); 

// Initialize Socket.io
const socket = io({ autoConnect: false });

// Helper for selecting DOM elements
const $ = id => document.getElementById(id);

// --- GLOBAL STATE ---
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let latestUserList = [];
let currentOwnerId = null;

// --- MEDIA STATE ---
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false;

// --- ARCADE STATE ---
let activeToolboxFile = null;

// --- WEBRTC CONNECTION STORAGE ---
const viewerPeers = {}; // Connections to viewers (One-way stream)
const callPeers = {};   // Connections to 1:1 callers (Two-way video)

// --- ICE SERVERS (STUN/TURN) ---
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ==========================================
// 3. UI & TABS LOGIC
// ==========================================

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
    
    // Deactivate all
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));
    
    // Activate target
    tabs[name].classList.add('active');
    contents[name].classList.add('active');
    
    // Clear notifications
    tabs[name].classList.remove('has-new');
}

// Bind Click Events
if(tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if(tabs.room) tabs.room.onclick = () => switchTab('room');
if(tabs.files) tabs.files.onclick = () => switchTab('files');
if(tabs.users) tabs.users.onclick = () => switchTab('users');


// ==========================================
// 4. DEVICE SETTINGS (Camera/Mic)
// ==========================================

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
if ($('closeSettingsBtn')) {
    $('closeSettingsBtn').addEventListener('click', () => {
        settingsPanel.style.display = 'none';
    });
}

async function getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        audioSource.innerHTML = ''; 
        videoSource.innerHTML = '';
        
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0,5)}`;
            if (d.kind === 'audioinput') audioSource.appendChild(opt);
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });

        // Set current selection
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at) audioSource.value = at.getSettings().deviceId;
            if (vt) videoSource.value = vt.getSettings().deviceId;
        }
    } catch(e) { console.error(e); }
}

// Auto-update media when selection changes
audioSource.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;


// ==========================================
// 5. MEDIA CONTROLS (Start/Stop/Share)
// ==========================================

async function startLocalMedia() {
    if (isScreenSharing) return; // Don't interrupt screen share

    // Stop old tracks
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    
    const constraints = {
        audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
        video: { deviceId: videoSource.value ? { exact: videoSource.value } : undefined }
    };

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; // Mute local preview
        
        // Update all active connections with new tracks
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
    } catch(e) { 
        console.error(e); 
        alert("Camera Error. Please check permissions or select a different device."); 
    }
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

// Toggle Buttons
if ($('toggleMicBtn')) $('toggleMicBtn').addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; updateMediaButtons(); }
});

if ($('toggleCamBtn')) $('toggleCamBtn').addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; updateMediaButtons(); }
});

// Screen Sharing Logic
if ($('shareScreenBtn')) $('shareScreenBtn').addEventListener('click', async () => {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            isScreenSharing = true;
            $('shareScreenBtn').textContent = 'Stop Screen';
            $('shareScreenBtn').classList.add('danger');
            
            // Show screen on local view
            $('localVideo').srcObject = screenStream;
            
            // Replace tracks in all connections
            const screenTrack = screenStream.getVideoTracks()[0];
            const updatePC = (pc) => {
                 if(!pc) return;
                 const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                 if(sender) sender.replaceTrack(screenTrack);
            };
            Object.values(viewerPeers).forEach(updatePC);
            Object.values(callPeers).forEach(p => updatePC(p.pc));
            
            // Handle user clicking "Stop Sharing" in browser UI
            screenTrack.onended = stopScreenShare;
        } catch(e) { console.error(e); }
    }
});

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    
    screenStream = null;
    isScreenSharing = false;
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    
    // Revert to Camera
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


// ==========================================
// 6. STREAMING (ONE-TO-MANY)
// ==========================================

if ($('startStreamBtn')) $('startStreamBtn').addEventListener('click', async () => {
    if (!currentRoom || !iAmHost) return alert("You must be the Host to stream.");
    
    if (isStreaming) {
        // STOP STREAM ONLY
        isStreaming = false;
        $('startStreamBtn').textContent = "Start Stream";
        $('startStreamBtn').classList.remove('danger');
        
        // Disconnect all viewers
        Object.values(viewerPeers).forEach(pc => pc.close());
        for (const k in viewerPeers) delete viewerPeers[k];
        return;
    }

    // START STREAM
    if (!localStream) await startLocalMedia();
    isStreaming = true;
    $('startStreamBtn').textContent = "Stop Stream"; 
    $('startStreamBtn').classList.add('danger');
    
    // Connect to everyone already in the room
    latestUserList.forEach(u => {
        if(u.id !== myId) connectViewer(u.id);
    });
});

// Auto-connect new users who join
socket.on('user-joined', ({ id, name }) => {
    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
});

// Clean up users who leave
socket.on('user-left', ({ id }) => {
    if (viewerPeers[id]) { 
        viewerPeers[id].close(); 
        delete viewerPeers[id]; 
    }
    endPeerCall(id, true);
});


// ==========================================
// 7. WEBRTC SIGNALING (The Handshake)
// ==========================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    // Send Ice Candidates
    pc.onicecandidate = e => { 
        if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); 
    };
    
    // Add Tracks (Video/Audio)
    const stream = isScreenSharing ? screenStream : localStream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    
    // --- ARCADE CHECK ---
    // If we have a game loaded, push it to this new viewer immediately
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing tool to ${targetId}`);
        pushFileToPeer(pc, activeToolboxFile, null); 
    }
    // --------------------

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


// ==========================================
// 8. 1:1 CALLING LOGIC
// ==========================================

socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`Incoming call from ${from}. Accept?`)) {
        await callPeer(fromId);
    }
});

async function callPeer(targetId) {
    if (!localStream) await startLocalMedia();
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, name: "Peer" };
    
    pc.onicecandidate = e => { if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate }); };
    
    // Receive their video
    pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]);
    
    // Send my video
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

// --- END CALL BUTTON LOGIC (FIXED) ---
if ($('hangupBtn')) $('hangupBtn').addEventListener('click', () => {
    // 1. Close all P2P calls (disconnect connection)
    Object.keys(callPeers).forEach(id => endPeerCall(id));
    
    // 2. DO NOT STOP CAMERA. 
    // User requested "It just needs to end call", not turn off hardware.
    // They have a separate "Camera Off" button for that.
});

socket.on('call-end', ({ from }) => endPeerCall(from, true));

function endPeerCall(id, isIncomingSignal) {
  if (callPeers[id]) { try { callPeers[id].pc.close(); } catch(e){} }
  delete callPeers[id];
  removeRemoteVideo(id);
  if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
  renderUserList();
}


// ==========================================
// 9. SOCKET CONNECTION & ROOM LOGIC
// ==========================================

socket.on('connect', () => { 
    $('signalStatus').className = 'status-dot status-connected'; 
    $('signalStatus').textContent = 'Connected'; 
    myId = socket.id; 
});

socket.on('disconnect', () => { 
    $('signalStatus').className = 'status-dot status-disconnected'; 
    $('signalStatus').textContent = 'Disconnected'; 
});

$('joinBtn').addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    if (!room) return;
    
    currentRoom = room; 
    userName = $('nameInput').value.trim() || 'Host';
    
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    
    $('joinBtn').disabled = true; 
    $('leaveBtn').disabled = false;
    
    updateLink(room);
    startLocalMedia();
});

if ($('leaveBtn')) $('leaveBtn').addEventListener('click', () => window.location.reload());

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users;
    currentOwnerId = ownerId;
    
    // Update Host Controls (If I am Host)
    if (streamTitle && $('streamTitleInput')) $('streamTitleInput').value = streamTitle;
    
    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? 'Unlock Room' : 'Lock Room';
        $('lockRoomBtn').onclick = () => { if(iAmHost) socket.emit('lock-room', !locked); };
    }
    
    renderUserList();
});

socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    if ($('localContainer')) $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});

// --- HOST EXTRAS (Title & Slug) ---
if ($('updateTitleBtn')) {
    $('updateTitleBtn').addEventListener('click', () => {
        const title = $('streamTitleInput').value.trim();
        if (title) socket.emit('update-title', title);
    });
}
if ($('updateSlugBtn')) {
    $('updateSlugBtn').addEventListener('click', () => {
        const slug = $('slugInput').value.trim();
        if (slug) updateLink(slug);
    });
}


// ==========================================
// 10. CHAT SYSTEM
// ==========================================

function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    
    // SAFE APPEND (No innerHTML for text)
    const s = document.createElement('strong'); s.textContent = name;
    const t = document.createElement('small'); t.textContent = new Date(ts).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    
    d.appendChild(s); d.appendChild(document.createTextNode(' ')); 
    d.appendChild(t); d.appendChild(txt);
    
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

function sendPublic() {
    const inp = $('inputPublic'); 
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPublic').addEventListener('click', sendPublic);
$('inputPublic').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPublic(); });

function sendPrivate() {
    const inp = $('inputPrivate'); 
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    
    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPrivate').addEventListener('click', sendPrivate);
$('inputPrivate').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPrivate(); });

// Receive Chats
socket.on('public-chat', d => { 
    appendChat($('chatLogPublic'), d.name, d.text, d.ts); 
    if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); 
});

socket.on('private-chat', d => { 
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts); 
    if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); 
});

// Emoji Clickers
if ($('emojiStripPublic')) $('emojiStripPublic').addEventListener('click', e => { 
    if(e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; 
});
if ($('emojiStripPrivate')) $('emojiStripPrivate').addEventListener('click', e => { 
    if(e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; 
});


// ==========================================
// 11. FILE SHARE TAB (Legacy)
// ==========================================

const fileInput = $('fileInput');
fileInput.addEventListener('change', () => { 
    if(fileInput.files.length) { 
        $('fileNameLabel').textContent = fileInput.files[0].name; 
        $('sendFileBtn').disabled = false; 
    } 
});

$('sendFileBtn').addEventListener('click', () => {
    const file = fileInput.files[0];
    if(!file || !currentRoom) return;
    
    const reader = new FileReader();
    reader.onload = () => {
        socket.emit('file-share', { room: currentRoom, name: userName, fileName: file.name, fileData: reader.result });
        fileInput.value = ''; 
        $('fileNameLabel').textContent = 'No file selected'; 
        $('sendFileBtn').disabled = true;
    };
    reader.readAsDataURL(file);
});

socket.on('file-share', d => {
    const div = document.createElement('div'); div.className = 'file-item';
    div.innerHTML = `<div><strong>${d.name}</strong> shared: ${d.fileName}</div><a href="${d.fileData}" download="${d.fileName}" class="btn small primary">Download</a>`;
    $('fileLog').appendChild(div);
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ==========================================
// 12. ARCADE TAB INPUT
// ==========================================

const arcadeInput = $('arcadeInput');
if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if(!file) return;
        
        activeToolboxFile = file;
        $('arcadeStatus').textContent = `Active Tool: ${file.name}`;
        
        // Push to everyone currently connected
        Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
    });
}


// ==========================================
// 13. USER LIST RENDERING & ACTIONS
// ==========================================

function renderUserList() {
    const list = $('userList'); 
    list.innerHTML = '';
    
    latestUserList.forEach(u => {
        if (u.id === myId) return; // Don't show myself
        
        const div = document.createElement('div'); 
        div.className = 'user-item';
        
        const isCalling = !!callPeers[u.id];
        let actionBtn = isCalling 
            ? `<button onclick="endPeerCall('${u.id}')" class="action-btn" style="border-color:var(--danger); color:var(--danger)">End Call</button>`
            : `<button onclick="ringUser('${u.id}')" class="action-btn">Call</button>`;
        
        const kickBtn = iAmHost 
            ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` 
            : '';

        div.innerHTML = `<span>${u.id === currentOwnerId ? '👑' : ''} ${u.name}</span><div class="user-actions">${actionBtn}${kickBtn}</div>`;
        list.appendChild(div);
    });
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`;
        d.innerHTML = `<video autoplay playsinline></video>`; 
        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); 
    if(v.srcObject !== stream) v.srcObject = stream;
}

function removeRemoteVideo(id) { 
    const el = document.getElementById(`vid-${id}`); 
    if(el) el.remove(); 
}

// Global functions for inline HTML buttons
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

if ($('openStreamBtn')) $('openStreamBtn').addEventListener('click', () => { 
    const url = $('streamLinkInput').value; 
    if(url) window.open(url, '_blank'); 
});
