// REBEL MESSENGER - FINAL PRODUCTION VERSION
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let activeChatMode = 'public';

// GLOBAL DATA
let latestUserList = [];
let currentOwnerId = null;

// MEDIA
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// STREAM PC (for host → viewers)
const viewerPeers = {};

// CALL PEERS (for multi-call)
const callPeers = {};
const remoteStreams = {};

// ICE
const ICE_SERVERS = (typeof ICE_CONFIG !== 'undefined' && ICE_CONFIG) ? ICE_CONFIG : [
    { urls: 'stun:stun.l.google.com:19302' }
];

const iceConfig = { iceServers: ICE_SERVERS };

// DOM helper
const $ = (id) => document.getElementById(id);

// TABS
const tabStream = $('tabStreamChat');
const tabRoom   = $('tabRoomChat');
const tabFiles  = $('tabFiles');
const tabUsers  = $('tabUsers');

const contentStream = $('contentStreamChat');
const contentRoom   = $('contentRoomChat');
const contentFiles  = $('contentFiles');
const contentUsers  = $('contentUsers');

function setActiveTab(tabName) {
    [tabStream, tabRoom, tabFiles, tabUsers].forEach(btn => btn && btn.classList.remove('active'));
    [contentStream, contentRoom, contentFiles, contentUsers].forEach(c => c && c.classList.remove('active'));

    if (tabName === 'stream') {
        tabStream && tabStream.classList.add('active');
        contentStream && contentStream.classList.add('active');
        activeChatMode = 'public';
    } else if (tabName === 'room') {
        tabRoom && tabRoom.classList.add('active');
        contentRoom && contentRoom.classList.add('active');
        activeChatMode = 'private';
    } else if (tabName === 'files') {
        tabFiles && tabFiles.classList.add('active');
        contentFiles && contentFiles.classList.add('active');
    } else if (tabName === 'users') {
        tabUsers && tabUsers.classList.add('active');
        contentUsers && contentUsers.classList.add('active');
    }
}

if (tabStream) tabStream.addEventListener('click', () => setActiveTab('stream'));
if (tabRoom)   tabRoom.addEventListener('click',   () => setActiveTab('room'));
if (tabFiles)  tabFiles.addEventListener('click',  () => setActiveTab('files'));
if (tabUsers)  tabUsers.addEventListener('click',  () => setActiveTab('users'));

// Settings panel
const settingsPanel  = $('settingsPanel');
const settingsBtn    = $('settingsBtn');
const closeSettingsBtn = $('closeSettingsBtn');
const audioSource    = $('audioSource');
const videoSource    = $('videoSource');
const applySettingsBtn = $('applySettingsBtn');

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        settingsPanel.style.display = 'block';
        getDevices();
    });
}
if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
        settingsPanel.style.display = 'none';
    });
}
if (applySettingsBtn) {
    applySettingsBtn.addEventListener('click', async () => {
        await startLocalMedia(true);
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
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            if (d.kind === 'audioinput') audioSource.appendChild(opt);
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at && at.getSettings().deviceId) audioSource.value = at.getSettings().deviceId;
            if (vt && vt.getSettings().deviceId) videoSource.value = vt.getSettings().deviceId;
        }
    } catch (e) {
        console.error(e);
    }
}
if (audioSource) audioSource.onchange = () => startLocalMedia(true);
if (videoSource) videoSource.onchange = () => startLocalMedia(true);

// --- MEDIA FUNCTIONS ---
const localVideo   = $('localVideo');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const startCallBtn = $('startCallBtn');
const hangupBtn    = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');

async function startLocalMedia(force = false) {
    try {
        if (!localStream || force) {
            const constraints = {
                audio: audioSource && audioSource.value ? { deviceId: { exact: audioSource.value } } : true,
                video: videoSource && videoSource.value ? { deviceId: { exact: videoSource.value } } : true
            };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            if (localVideo) localVideo.srcObject = localStream;
            updateMediaButtons();
        }
    } catch (e) {
        console.error('Error starting media', e);
        alert('Could not start camera/mic.');
    }
}

function updateMediaButtons() {
    if (!localStream) return;
    const aTrack = localStream.getAudioTracks()[0];
    const vTrack = localStream.getVideoTracks()[0];
    if (toggleCamBtn) {
        toggleCamBtn.textContent = (vTrack && vTrack.enabled) ? 'Camera On' : 'Camera Off';
        toggleCamBtn.classList.toggle('danger', !(vTrack && vTrack.enabled));
    }
    if (toggleMicBtn) {
        toggleMicBtn.textContent = (aTrack && aTrack.enabled) ? 'Mute' : 'Unmute';
        toggleMicBtn.classList.toggle('danger', !(aTrack && aTrack.enabled));
    }
}

// --- BUTTON LISTENERS ---
if (toggleMicBtn) {
    toggleMicBtn.addEventListener('click', () => {
        if (!localStream) return;
        const track = localStream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        updateMediaButtons();
    });
}

if (toggleCamBtn) {
    toggleCamBtn.addEventListener('click', () => {
        if (!localStream) return;
        const track = localStream.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        updateMediaButtons();
    });
}

if (shareScreenBtn) {
    shareScreenBtn.addEventListener('click', async () => {
        try {
            if (!screenStream) {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                isScreenSharing = true;
            } else {
                screenStream = null;
                isScreenSharing = false;
            }

            // Update any existing viewer/call PC with screen vs camera
            const stream = isScreenSharing ? screenStream : localStream;
            if (!stream) return;

            const camTrack = stream.getVideoTracks()[0];
            const updatePC = (pc) => {
                if (!pc) return;
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender && camTrack) sender.replaceTrack(camTrack);
            };
            Object.values(viewerPeers).forEach(updatePC);
            Object.values(callPeers).forEach(p => updatePC(p.pc));
        } catch (e) {
            console.error('screen share error', e);
        }
    });
}

// --- CALLING (P2P) ---
if (startCallBtn) {
    startCallBtn.addEventListener('click', async () => {
        if (!currentRoom) return alert('Join a room first');
        await startLocalMedia();
        hangupBtn && (hangupBtn.disabled = false);
    });
}

if (hangupBtn) {
    hangupBtn.addEventListener('click', () => {
        Object.keys(callPeers).forEach(endPeerCall);
        hangupBtn.disabled = true;
    });
}

socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`📞 Incoming call from ${from}. Accept?`)) {
        await callPeer(fromId);
    }
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
    const peer = callPeers[from];
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('call-ice', async ({ from, candidate }) => {
    const peer = callPeers[from];
    if (!peer || !candidate) return;
    try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
        console.error('Error adding ICE', e);
    }
});

socket.on('call-end', ({ from }) => {
    endPeerCall(from);
});

function endPeerCall(id) {
    const peer = callPeers[id];
    if (peer && peer.pc) peer.pc.close();
    delete callPeers[id];
    removeRemoteVideo(id);
    renderUserList();
}

// --- STREAMING (HOST) ---
const startStreamBtn   = $('startStreamBtn');
const streamLinkInput  = $('streamLinkInput');
const openStreamBtn    = $('openStreamBtn');

let isStreaming = false;

if (startStreamBtn) {
    startStreamBtn.addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) return alert("Host only");

        // TOGGLE LOGIC: STOP
        if (isStreaming) {
            isStreaming = false;
            startStreamBtn.textContent = "Start Stream";
            startStreamBtn.classList.remove('danger');
            
            // Close all viewer connections
            Object.values(viewerPeers).forEach(pc => pc.close());
            for (const k in viewerPeers) delete viewerPeers[k];
            return;
        }

        // TOGGLE LOGIC: START
        if (!localStream) await startLocalMedia();
        isStreaming = true;
        startStreamBtn.textContent = "Stop Stream";
        startStreamBtn.classList.add('danger');

        // Link uses slug or room
        updateLink(currentRoom);

        // Connect all existing users as viewers
        latestUserList.forEach(u => {
            if (u.id !== myId) connectViewer(u.id);
        });
    });
}

if (openStreamBtn) {
    openStreamBtn.addEventListener('click', () => {
        if (!streamLinkInput || !streamLinkInput.value) return;
        window.open(streamLinkInput.value, '_blank');
    });
}

socket.on('webrtc-answer', async ({ sdp, from }) => {
    const pc = viewerPeers[from];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
});

socket.on('webrtc-ice-candidate', async ({ candidate, from }) => {
    const pc = viewerPeers[from];
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error('Error adding ICE', err);
        }
    }
});

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate });
    };

    const stream = isScreenSharing ? screenStream : localStream;
    if (!stream) return;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

// --- ROOM JOIN / ROLE / LINK ---
const roomInput = $('roomInput');
const nameInput = $('nameInput');
const joinBtn   = $('joinBtn');
const roomStatus = $('roomStatus');
const roomNameLabel = $('roomNameLabel');
const youNameLabel  = $('youNameLabel');
const roleLabel     = $('roleLabel');

if (joinBtn) {
    joinBtn.addEventListener('click', () => {
        const room = roomInput.value.trim();
        const name = nameInput.value.trim();
        if (!room) {
            alert('Enter a room name');
            return;
        }
        currentRoom = room;
        userName = name || 'User';
        roomStatus.textContent = `Joining ${room}...`;

        socket.connect();
        socket.emit('join-room', { room, name: userName });
    });
}

socket.on('room-error', (msg) => {
    roomStatus.textContent = msg;
});

socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    if (roleLabel) roleLabel.textContent = isHost ? 'Host 👑' : 'Guest';
    if ($('localLabel')) $('localLabel').textContent = isHost ? 'You (Host 👑)' : 'You';
});

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users;
    currentOwnerId = ownerId;
    if (roomNameLabel && currentRoom) roomNameLabel.textContent = currentRoom;
    if (youNameLabel && userName) youNameLabel.textContent = userName;
    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
        $('lockRoomBtn').onclick = () => { if(iAmHost) socket.emit('lock-room', !locked); };
    }
    if (streamTitle && $('headerTitle')) {
        $('headerTitle').textContent = `Rebel Messenger — ${streamTitle}`;
    }
    renderUserList();
});

// --- CHAT HELPERS ---
function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    d.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text}`;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

// PUBLIC
const chatLogPublic  = $('chatLogPublic');
const inputPublic    = $('inputPublic');
const btnSendPublic  = $('btnSendPublic');
const emojiStripPublic = $('emojiStripPublic');

socket.on('public-chat', d => {
    appendChat(chatLogPublic, d.name, d.text, d.ts);
    if(!tabStream.classList.contains('active')) tabStream.classList.add('has-new');
});

if (btnSendPublic) {
    btnSendPublic.addEventListener('click', () => {
        const text = inputPublic.value.trim();
        if(!text) return;
        socket.emit('public-chat', { room: currentRoom, name: userName, text });
        inputPublic.value = '';
    });
}

if (emojiStripPublic) {
    emojiStripPublic.addEventListener('click', e => {
        if (!e.target.classList.contains('emoji')) return;
        inputPublic.value += e.target.textContent;
        inputPublic.focus();
    });
}

// PRIVATE
const chatLogPrivate = $('chatLogPrivate');
const inputPrivate   = $('inputPrivate');
const btnSendPrivate = $('btnSendPrivate');
const emojiStripPrivate = $('emojiStripPrivate');

socket.on('private-chat', d => {
    appendChat(chatLogPrivate, d.name, d.text, d.ts);
    if(!tabRoom.classList.contains('active')) tabRoom.classList.add('has-new');
});

if (btnSendPrivate) {
    btnSendPrivate.addEventListener('click', () => {
        const text = inputPrivate.value.trim();
        if(!text) return;
        socket.emit('private-chat', { room: currentRoom, name: userName, text });
        inputPrivate.value = '';
    });
}

if (emojiStripPrivate) {
    emojiStripPrivate.addEventListener('click', e => {
        if (!e.target.classList.contains('emoji')) return;
        inputPrivate.value += e.target.textContent;
        inputPrivate.focus();
    });
}

// --- FILE LOGIC ---
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileLog = $('fileLog');
const fileNameLabel = $('fileNameLabel'); // may be null if not in DOM

if (fileInput && sendFileBtn) {
    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length > 0) {
            const file = fileInput.files[0];
            if (fileNameLabel) fileNameLabel.textContent = file.name;
            sendFileBtn.disabled = false;
        } else {
            if (fileNameLabel) fileNameLabel.textContent = 'No file selected';
            sendFileBtn.disabled = true;
        }
    });

    sendFileBtn.addEventListener('click', () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            socket.emit('file-share', {
                room: currentRoom,
                name: userName,
                fileName: file.name,
                fileType: file.type || 'application/octet-stream',
                fileData: reader.result   // data:URL → server saves + turns into link
            });
            fileInput.value = '';
            if (fileNameLabel) fileNameLabel.textContent = 'No file selected';
            sendFileBtn.disabled = true;
        };
        reader.readAsDataURL(file);
    });
}

socket.on('file-share', ({ name, fileName, fileData, fileUrl }) => {
    if (!fileLog) return;
    const href = fileUrl || fileData; // prefer server URL, fallback to data: URL

    const d = document.createElement('div');
    d.className = 'file-item';
    d.innerHTML = `
        <div><strong>${name}</strong> shared: ${fileName}</div>
        <a href="${href}" download="${fileName}" class="btn small primary">Download</a>
    `;
    fileLog.appendChild(d);
    fileLog.scrollTop = fileLog.scrollHeight;
    if(!tabFiles.classList.contains('active')) tabFiles.classList.add('has-new');
});

// --- RENDER USER LIST ---
function renderUserList() {
    const list = $('userList'); 
    if(!list) return;
    list.innerHTML = '';
    
    if (!latestUserList) return;

    latestUserList.forEach(u => {
        if (u.id === myId) return;
        
        const div = document.createElement('div');
        div.className = 'user-item';
        
        const isHostUser = (u.id === currentOwnerId);

        div.innerHTML = `
          <div class="user-main">
            <span class="user-name">${u.name || u.id}</span>
            ${isHostUser ? '<span class="crown">👑</span>' : ''}
          </div>
          <div class="user-actions">
            <button class="btn small secondary" onclick="ringUser('${u.id}')">Ring</button>
            ${iAmHost ? `<button class="btn small danger" onclick="kickUser('${u.id}')">Kick</button>` : ''}
          </div>
        `;
        list.appendChild(div);
    });
}

// --- VIDEO HELPERS ---
function addRemoteVideo(id, stream) {
    let existing = document.getElementById(`vid-${id}`);
    if (existing) {
        const vid = existing.querySelector('video');
        if (vid && vid.srcObject !== stream) vid.srcObject = stream;
        return; 
    }
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

// LEAVE BUTTON LOGIC
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

socket.on('connect', () => {
    myId = socket.id;
});

socket.on('user-joined', ({ id, name }) => {
    appendChat(chatLogPrivate, 'System', `${name} joined room`, Date.now());
    renderUserList();
});

socket.on('user-left', ({ id }) => {
    appendChat(chatLogPrivate, 'System', `User ${id} left`, Date.now());
    removeRemoteVideo(id);
    renderUserList();
});

window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);
window.endPeerCall = endPeerCall;
