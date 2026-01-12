// REBEL MESSENGER CLIENT - FULL VERSION
const socket = io({ autoConnect: false });

// STATE
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// MEDIA
let localStream = null;
let isScreenSharing = false;

// STREAMING (Host -> Viewer)
let pc = null; 
let isStreaming = false;
let broadcastStream = null;

// P2P CALLS (Mesh)
const callPeers = {}; // { [id]: { pc, name, iceQueue } }

// CONFIG
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- DOM UTILS ---
const $ = id => document.getElementById(id);

// --- 1. MEDIA & DEVICES ---
async function getMedia(constraints) {
    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        console.error("Media Error:", err);
        alert("Could not access Camera/Mic. Please check permissions.");
        return null;
    }
}

async function getDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audios = devices.filter(d => d.kind === 'audioinput');
        const videos = devices.filter(d => d.kind === 'videoinput');
        
        if($('audioSource')) $('audioSource').innerHTML = audios.map(d => `<option value="${d.deviceId}">${d.label || 'Mic ' + d.deviceId.slice(0,4)}</option>`).join('');
        if($('videoSource')) $('videoSource').innerHTML = videos.map(d => `<option value="${d.deviceId}">${d.label || 'Cam ' + d.deviceId.slice(0,4)}</option>`).join('');
    } catch(e) { console.error(e); }
}

async function ensureLocalStream() {
    if (localStream && localStream.active) return localStream;
    
    // Read selections
    const aId = $('audioSource') ? $('audioSource').value : undefined;
    const vId = $('videoSource') ? $('videoSource').value : undefined;

    // Use "exact" only if ID is present, otherwise let browser choose
    const constraints = {
        audio: aId ? { deviceId: { exact: aId } } : true,
        video: vId ? { deviceId: { exact: vId } } : true
    };

    localStream = await getMedia(constraints);
    if(localStream) {
        const v = $('localVideo');
        if(v) { v.srcObject = localStream; v.muted = true; }
        
        // If we are already streaming, update the track on the fly
        if(isStreaming && pc) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if(sender) sender.replaceTrack(localStream.getVideoTracks()[0]);
        }
    }
    return localStream;
}

// --- 2. VIDEO GRID ---
function addRemoteVideo(id, stream, name) {
    const grid = $('videoGrid');
    if(!grid) return;
    
    let div = document.getElementById(`vid-${id}`);
    if(!div) {
        div = document.createElement('div');
        div.id = `vid-${id}`;
        div.className = 'video-container';
        div.innerHTML = `<h2>${name || 'Peer'}</h2><video autoplay playsinline></video>`;
        grid.appendChild(div);
    }
    div.querySelector('video').srcObject = stream;
}

function removeRemoteVideo(id) {
    const div = document.getElementById(`vid-${id}`);
    if(div) div.remove();
}

// --- 3. CALL LOGIC (P2P) ---
function createPeer(targetId, name) {
    const cp = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc: cp, name: name, iceQueue: [] };

    cp.onicecandidate = e => {
        if(e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate });
    };

    cp.ontrack = e => addRemoteVideo(targetId, e.streams[0], name);

    return cp;
}

async function startCall(targetId) {
    const stream = await ensureLocalStream();
    if(!stream) return;

    const peerEl = document.querySelector(`[data-userid="${targetId}"]`);
    const name = peerEl ? peerEl.dataset.username : "Peer";
    
    const cp = createPeer(targetId, name);
    stream.getTracks().forEach(t => cp.addTrack(t, stream));

    const offer = await cp.createOffer();
    await cp.setLocalDescription(offer);
    
    socket.emit('call-offer', { targetId, offer });
    
    // Update End Button
    const btn = document.querySelector(`button[onclick="endPeerCall('${targetId}')"]`);
    if(btn) { btn.disabled = false; btn.classList.add('danger'); }
}

function endPeerCall(id, fromRemote = false) {
    const p = callPeers[id];
    if(p && p.pc) p.pc.close();
    delete callPeers[id];
    removeRemoteVideo(id);
    
    if(!fromRemote) socket.emit('call-end', { targetId: id });
    
    const btn = document.querySelector(`button[onclick="endPeerCall('${id}')"]`);
    if(btn) { btn.disabled = true; btn.classList.remove('danger'); }
}
window.endPeerCall = endPeerCall; // Global for onclick

// --- 4. SOCKET LISTENERS (CALLS) ---
socket.on('ring-alert', ({ from, fromId }) => {
    if(confirm(`${from} is calling! Answer?`)) startCall(fromId);
});

socket.on('incoming-call', async ({ from, name, offer }) => {
    const stream = await ensureLocalStream();
    const cp = createPeer(from, name);
    
    await cp.setRemoteDescription(new RTCSessionDescription(offer));
    if(stream) stream.getTracks().forEach(t => cp.addTrack(t, stream));
    
    const answer = await cp.createAnswer();
    await cp.setLocalDescription(answer);
    socket.emit('call-answer', { targetId: from, answer });
    
    // Flush ICE
    if(callPeers[from].iceQueue.length) {
        callPeers[from].iceQueue.forEach(c => cp.addIceCandidate(c));
        callPeers[from].iceQueue = [];
    }
    
    const btn = document.querySelector(`button[onclick="endPeerCall('${from}')"]`);
    if(btn) { btn.disabled = false; btn.classList.add('danger'); }
});

socket.on('call-answer', async ({ from, answer }) => {
    const p = callPeers[from];
    if(p && p.pc) {
        await p.pc.setRemoteDescription(new RTCSessionDescription(answer));
        p.iceQueue.forEach(c => p.pc.addIceCandidate(c));
        p.iceQueue = [];
    }
});

socket.on('call-ice', ({ from, candidate }) => {
    const p = callPeers[from];
    if(p && p.pc) {
        if(p.pc.remoteDescription) p.pc.addIceCandidate(new RTCIceCandidate(candidate));
        else p.iceQueue.push(new RTCIceCandidate(candidate));
    }
});

socket.on('call-end', ({ from }) => endPeerCall(from, true));

// --- 5. STREAMING (HOST) ---
const startStreamBtn = $('startStreamBtn');
if(startStreamBtn) {
    startStreamBtn.addEventListener('click', async () => {
        if(!iAmHost) return alert("Host only");
        
        if(pc) pc.close();
        pc = new RTCPeerConnection(iceConfig);
        
        const q = $('streamQuality') ? $('streamQuality').value : '720';
        let streamToSend;
        
        if(q === 'screen') {
            try {
                streamToSend = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                isScreenSharing = true;
            } catch(e) { return; }
        } else {
            const h = parseInt(q) || 720;
            await ensureLocalStream();
            try { await localStream.getVideoTracks()[0].applyConstraints({height:{ideal:h}}); } catch(e){}
            streamToSend = localStream;
            isScreenSharing = false;
        }

        streamToSend.getTracks().forEach(t => pc.addTrack(t, streamToSend));
        
        pc.onicecandidate = e => {
            if(e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
        };
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
        
        startStreamBtn.textContent = 'Live';
        startStreamBtn.classList.add('danger');
        isStreaming = true;
        if($('hangupBtn')) $('hangupBtn').disabled = false;
    });
}

// Handshake for stream
socket.on('webrtc-answer', async ({ sdp }) => {
    if(pc) try { await pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch(e){}
});
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if(pc) try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){}
});

// --- 6. FILE SHARING ---
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');

if(fileInput && sendFileBtn) {
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        $('fileNameLabel').textContent = file ? file.name : 'No file selected';
        sendFileBtn.disabled = !file;
    });

    sendFileBtn.addEventListener('click', () => {
        const file = fileInput.files[0];
        if(!file) return;
        if(file.size > 20 * 1024 * 1024) return alert("File too large (Max 20MB)");

        const reader = new FileReader();
        reader.onload = (e) => {
            socket.emit('file-share', {
                room: currentRoom,
                name: userName,
                fileName: file.name,
                fileType: file.type,
                fileData: e.target.result // Base64
            });
            appendFile('You', file.name, e.target.result);
            $('fileNameLabel').textContent = 'Sent!';
            sendFileBtn.disabled = true;
            fileInput.value = ''; 
        };
        reader.readAsDataURL(file);
    });
}

socket.on('file-share', (data) => {
    appendFile(data.name, data.fileName, data.fileData);
});

function appendFile(sender, fileName, dataUrl) {
    const log = $('fileLog');
    if(!log) return;
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `
        <div><strong>${sender}</strong> shared: ${fileName}</div>
        <a href="${dataUrl}" download="${fileName}" class="btn small">Download</a>
    `;
    log.appendChild(div);
}

// --- 7. CHAT & UI ---
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');

function appendChat(name, text) {
    const log = $('chatLog');
    if(!log) return;
    const div = document.createElement('div');
    div.className = 'chat-line';
    div.innerHTML = `<strong>${name}:</strong> ${text}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

if(sendBtn) {
    sendBtn.addEventListener('click', () => {
        const txt = chatInput.value.trim();
        if(txt) {
            socket.emit('chat-message', { room: currentRoom, name: userName, text: txt });
            chatInput.value = '';
        }
    });
}

if($('emojiStrip')) {
    $('emojiStrip').addEventListener('click', e => {
        if(e.target.classList.contains('emoji')) {
            chatInput.value += e.target.textContent;
            chatInput.focus();
        }
    });
}

socket.on('chat-message', d => appendChat(d.name, d.text));

// --- 8. ROOM UPDATES ---
socket.on('room-update', d => {
    const list = $('userList');
    if(list) {
        list.innerHTML = '';
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
                   <button onclick="ringUser('${u.id}')" class="action-btn ring">📞</button>
                   <button onclick="endPeerCall('${u.id}')" class="${inCall?'action-btn danger':'action-btn'}" ${inCall?'':'disabled'}>End</button>
                   ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
                </div>`;
            list.appendChild(div);
        });
    }

    // Host Controls
    if(d.ownerId === myId) {
        iAmHost = true;
        if($('hostControls')) $('hostControls').style.display = 'block';
        if($('streamTitleInput')) $('streamTitleInput').value = d.streamTitle || '';
        if($('slugInput')) $('slugInput').value = d.publicSlug || '';
    } else {
        iAmHost = false;
        if($('hostControls')) $('hostControls').style.display = 'none';
        if($('streamTitleInput')) $('streamTitleInput').value = d.streamTitle || '';
    }

    // Link update
    const id = d.publicSlug || currentRoom;
    if($('streamLinkInput') && id) {
         const url = new URL(window.location.href);
         url.pathname = url.pathname.replace('index.html', '') + 'view.html';
         url.search = `?room=${encodeURIComponent(id)}`;
         $('streamLinkInput').value = url.toString();
    }
});

socket.on('connect', () => { 
    if($('signalStatus')) $('signalStatus').className = 'status-dot status-connected'; 
    myId = socket.id;
});
socket.on('disconnect', () => { 
    if($('signalStatus')) $('signalStatus').className = 'status-dot status-disconnected'; 
});
socket.on('user-joined', d => appendChat('System', `${d.name} joined`));
socket.on('kicked', () => window.location.reload());
socket.on('room-error', msg => alert(msg));
socket.on('role', d => { if(d.isHost) iAmHost = true; });

// --- 9. HOST BUTTONS ---
if($('updateTitleBtn')) $('updateTitleBtn').addEventListener('click', () => {
    const t = $('streamTitleInput').value.trim();
    if(t) socket.emit('update-stream-title', t);
});

if($('updateSlugBtn')) $('updateSlugBtn').addEventListener('click', () => {
    const s = $('slugInput').value.trim();
    if(s) socket.emit('update-public-slug', s);
});

if($('lockRoomBtn')) $('lockRoomBtn').addEventListener('click', () => {
    socket.emit('lock-room', true); // Server toggles state
});
window.kickUser = (id) => socket.emit('kick-user', id);
window.ringUser = (id) => {
    if(!currentRoom) return alert("Join room first");
    socket.emit('ring-user', id);
};

// --- 10. INIT ---
if($('joinBtn')) {
    $('joinBtn').addEventListener('click', () => {
        const r = $('roomInput').value;
        const n = $('nameInput').value;
        if(!r) return alert("Room ID required");
        currentRoom = r;
        userName = n || 'Anon';
        socket.connect();
        socket.emit('join-room', { room: r, name: userName });
        $('joinBtn').disabled = true;
        if($('leaveBtn')) $('leaveBtn').disabled = false;
        ensureLocalStream();
    });
}
if($('leaveBtn')) $('leaveBtn').addEventListener('click', () => window.location.reload());
if($('settingsBtn')) $('settingsBtn').addEventListener('click', async () => {
    const p = $('settingsPanel');
    if(p) {
        p.style.display = (p.style.display === 'none') ? 'block' : 'none';
        if(p.style.display === 'block') await getDevices();
    }
});
if($('closeSettingsBtn')) $('closeSettingsBtn').addEventListener('click', () => {
    if($('settingsPanel')) $('settingsPanel').style.display = 'none';
    ensureLocalStream();
});
if($('toggleCamBtn')) $('toggleCamBtn').addEventListener('click', () => {
    if(localStream) {
        const t = localStream.getVideoTracks()[0];
        if(t) { t.enabled = !t.enabled; $('toggleCamBtn').textContent = t.enabled ? 'Cam Off' : 'Cam On'; }
    }
});
if($('toggleMicBtn')) $('toggleMicBtn').addEventListener('click', () => {
    if(localStream) {
        const t = localStream.getAudioTracks()[0];
        if(t) { t.enabled = !t.enabled; $('toggleMicBtn').textContent = t.enabled ? 'Mute' : 'Unmute'; }
    }
});
if($('openStreamBtn')) $('openStreamBtn').addEventListener('click', () => {
    const v = $('streamLinkInput').value;
    if(v) window.open(v, '_blank');
});
if($('hangupBtn')) $('hangupBtn').addEventListener('click', () => {
   if(isStreaming && pc) { pc.close(); pc=null; isStreaming=false; $('startStreamBtn').textContent='Start Stream'; $('startStreamBtn').classList.remove('danger'); }
   Object.keys(callPeers).forEach(id => endPeerCall(id));
   $('hangupBtn').disabled = true;
});
