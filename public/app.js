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

// STREAM VIEWERS
const viewerPeers = {};
const callPeers = {};
const remoteStreams = {};

let isStreaming = false;

// DOM UTILS
const $ = id => document.getElementById(id);

// TABS
const tabs = {
    stream: $('tabStream'),
    room: $('tabRoom'),
    files: $('tabFiles'),
    users: $('tabUsers'),
};

function switchTab(tabName) {
    const contents = {
        stream: $('contentStreamChat'),
        room: $('contentRoomChat'),
        files: $('contentFiles'),
        users: $('contentUsers'),
    };
    Object.values(contents).forEach(c => c.classList.remove('active'));
    Object.values(tabs).forEach(b => b.classList.remove('active', 'has-new'));

    if (contents[tabName]) contents[tabName].classList.add('active');
    if (tabs[tabName]) tabs[tabName].classList.add('active');

    activeChatMode = (tabName === 'stream') ? 'public' : (tabName === 'room' ? 'private' : activeChatMode);
}
if (tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if (tabs.room) tabs.room.onclick = () => switchTab('room');
if (tabs.files) tabs.files.onclick = () => switchTab('files');
if (tabs.users) tabs.users.onclick = () => switchTab('users');


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

async function getDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        audioSource.innerHTML = '';
        videoSource.innerHTML = '';

        devices.forEach(device => {
            const opt = document.createElement('option');
            opt.value = device.deviceId;
            opt.textContent = device.label || `${device.kind} device`;
            if (device.kind === 'audioinput') audioSource.appendChild(opt);
            if (device.kind === 'videoinput') videoSource.appendChild(opt);
        });
    } catch (e) {
        console.error('Error getting devices', e);
    }
}

async function getMedia(useScreen = false) {
    if (useScreen) {
        return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    }
    const constraints = {
        audio: audioSource.value ? { deviceId: { exact: audioSource.value } } : true,
        video: videoSource.value ? { deviceId: { exact: videoSource.value } } : true
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
}

const localVideo = $('localVideo');
const startCamBtn = $('startCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const screenShareBtn = $('screenShareBtn');

if (startCamBtn) startCamBtn.onclick = async () => {
    try {
        if (!localStream) {
            localStream = await getMedia(false);
            localVideo.srcObject = localStream;
        }
    } catch (err) {
        console.error('Error starting camera', err);
    }
};

if (toggleMicBtn) toggleMicBtn.onclick = () => {
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    const enabled = audioTracks[0].enabled;
    audioTracks.forEach(t => t.enabled = !enabled);
    toggleMicBtn.textContent = enabled ? '🎙️ Unmute' : '🎙️ Mute';
};

if (screenShareBtn) screenShareBtn.onclick = async () => {
    try {
        if (!screenStream) {
            screenStream = await getMedia(true);
            isScreenSharing = true;
            if (isStreaming) {
                Object.values(viewerPeers).forEach(pc => {
                    pc.getSenders().forEach(s => {
                        if (s.track && s.track.kind === 'video') {
                            s.replaceTrack(screenStream.getVideoTracks()[0]);
                        }
                    });
                });
            }
        } else {
            isScreenSharing = false;
            screenStream = null;
            if (isStreaming && localStream) {
                Object.values(viewerPeers).forEach(pc => {
                    pc.getSenders().forEach(s => {
                        if (s.track && s.track.kind === 'video') {
                            s.replaceTrack(localStream.getVideoTracks()[0]);
                        }
                    });
                });
            }
        }
    } catch (err) {
        console.error('Error toggling screen share', err);
    }
};

// --- ROOM JOIN ---
const roomInput = $('roomInput');
const nameInput = $('nameInput');
const joinBtn = $('joinBtn');
const roomStatus = $('roomStatus');

if (joinBtn) joinBtn.onclick = () => {
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
};

socket.on('room-error', (msg) => {
    roomStatus.textContent = msg;
});

socket.on('role', ({ isHost, streamTitle }) => {
    iAmHost = isHost;
    const localContainer = $('localContainer');
    if (localContainer) {
        localContainer.querySelector('h2').textContent = isHost ? 'You (Host) 👑' : 'You';
    }
    const hostControls = $('hostControls');
    if (hostControls) hostControls.style.display = isHost ? 'block' : 'none';

    if (streamTitle) {
        $('headerTitle').textContent = `Rebel Messenger — ${streamTitle}`;
    }
});

socket.on('room-update', ({ users, ownerId, locked, streamTitle }) => {
    latestUserList = users;
    currentOwnerId = ownerId;
    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
        $('lockRoomBtn').onclick = () => { if(iAmHost) socket.emit('lock-room', !locked); };
    }
    renderUserList();
});

socket.on('user-joined', ({ id, name }) => {
    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
});

socket.on('user-left', ({ id }) => {
    appendChat($('chatLogPrivate'), 'System', `User ${id} left`, Date.now());
    if (viewerPeers[id]) {
        viewerPeers[id].close();
        delete viewerPeers[id];
    }
    removeRemoteVideo(id);
    renderUserList();
});

// --- HOST CONTROLS UI ---
if ($('lockRoomBtn')) {
    $('lockRoomBtn').onclick = () => {
        if (!iAmHost) return;
        socket.emit('lock-room', true);
    };
}

if ($('updateTitleBtn')) {
    $('updateTitleBtn').onclick = () => {
        if (!iAmHost) return;
        const t = $('streamTitleInput').value.trim();
        socket.emit('update-stream-title', t);
    };
}

if ($('startStreamBtn')) {
    $('startStreamBtn').onclick = async () => {
        if (!iAmHost) return;
        if (!localStream) {
            localStream = await getMedia(false);
            localVideo.srcObject = localStream;
        }
        isStreaming = true;
        $('streamLinkInput').value = `${window.location.origin}/view.html?room=${encodeURIComponent(currentRoom)}`;
        latestUserList.forEach(u => {
            if (u.id !== myId) connectViewer(u.id);
        });
    };
}

if ($('stopStreamBtn')) {
    $('stopStreamBtn').onclick = () => {
        if (!iAmHost) return;
        isStreaming = false;
        Object.values(viewerPeers).forEach(pc => pc.close());
        for (const k in viewerPeers) delete viewerPeers[k];
    };
}

// --- VIEWER WEBRTC HELPERS ---
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

socket.on('connect', () => {
    myId = socket.id;
});

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

// --- CALLING LOGIC (1:1) ---
socket.on('ring-alert', ({ from, fromId }) => {
    appendChat($('chatLogPrivate'), 'System', `Incoming ring from ${from}`, Date.now());
});

socket.on('incoming-call', async ({ from, name, offer }) => {
    const accept = confirm(`Accept call from ${name}?`);
    if (!accept) return;

    let pc = callPeers[from];
    if (!pc) {
        pc = new RTCPeerConnection(iceConfig);
        callPeers[from] = pc;
    }
    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('call-ice', { targetId: from, candidate: e.candidate });
    };
    pc.ontrack = e => attachRemoteStream(from, e.streams[0]);

    if (!localStream) {
        localStream = await getMedia(false);
        localVideo.srcObject = localStream;
    }
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('call-answer', { targetId: from, answer });
});

socket.on('call-answer', async ({ from, answer }) => {
    const pc = callPeers[from];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
});

socket.on('call-ice', async ({ from, candidate }) => {
    const pc = callPeers[from];
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error('Call ICE error', err);
        }
    }
});

socket.on('call-end', ({ from }) => {
    endPeerCall(from);
});

function attachRemoteStream(id, stream) {
    remoteStreams[id] = stream;
    addRemoteVideo(id, stream);
}

function endPeerCall(id) {
    const pc = callPeers[id];
    if (pc) {
        pc.close();
        delete callPeers[id];
    }
    removeRemoteVideo(id);
}

if ($('endCallBtn')) {
    $('endCallBtn').onclick = () => {
        Object.keys(callPeers).forEach(endPeerCall);
    };
}

// --- CHAT HELPERS ---
function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    d.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text}`;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

// PUBLIC
socket.on('public-chat', d => {
    appendChat($('chatLogPublic'), d.name, d.text, d.ts);
    if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new');
});
$('btnSendPublic').addEventListener('click', () => {
    const inp = $('inputPublic');
    const text = inp.value.trim();
    if(!text) return;
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
});

// PRIVATE
socket.on('private-chat', d => {
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts);
    if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new');
});
$('btnSendPrivate').addEventListener('click', () => {
    const inp = $('inputPrivate');
    const text = inp.value.trim();
    if(!text) return;
    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
});

// --- EMOJI LOGIC (FIXED) ---
const emojiStripPublic = $('emojiStripPublic');
const emojiStripPrivate = $('emojiStripPrivate');

if (emojiStripPublic) {
    emojiStripPublic.addEventListener('click', (e) => {
        if (e.target.classList.contains('emoji')) {
            const inp = $('inputPublic');
            inp.value += e.target.textContent;
            inp.focus();
        }
    });
}
if (emojiStripPrivate) {
    emojiStripPrivate.addEventListener('click', (e) => {
        if (e.target.classList.contains('emoji')) {
            const inp = $('inputPrivate');
            inp.value += e.target.textContent;
            inp.focus();
        }
    });
}

// --- FILE LOGIC ---
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileLog = $('fileLog');
const fileNameLabel = $('fileNameLabel');

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
                fileData: reader.result,   // data:URL, server saves to /uploads
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
    const href = fileUrl || fileData; // prefer server URL
    const d = document.createElement('div');
    d.className = 'file-item';
    d.innerHTML = `
        <div><strong>${name}</strong> shared: ${fileName}</div>
        <a href="${href}" download="${fileName}" class="btn small primary">Download</a>
    `;
    fileLog.appendChild(d);
    fileLog.scrollTop = fileLog.scrollHeight;
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
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
    const v = d.querySelector('video');
    v.srcObject = stream;
    $('remoteVideos').appendChild(d);
}

function removeRemoteVideo(id) {
    const el = document.getElementById(`vid-${id}`);
    if(el) el.remove();
}

window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

if ($('openStreamBtn')) $('openStreamBtn').addEventListener('click', () => {
   const url = $('streamLinkInput').value;
   if(url) window.open(url, '_blank');
});
