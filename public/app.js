const socket = io({ autoConnect: false });

// STATE
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// MESH NETWORKING: Object to hold multiple connections
// Format: { [socketId]: { pc: RTCPeerConnection } }
const peers = {}; 

let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// ICE Config
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM
const $ = id => document.getElementById(id);
const localVideo = $('localVideo');
const remoteGrid = $('remoteVideosGrid');
const joinBtn = $('joinBtn');
const callAllBtn = $('callAllBtn');
const hangupBtn = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const settingsBtn = $('settingsBtn');
const settingsPanel = $('settingsPanel');
const closeSettingsBtn = $('closeSettingsBtn');
const audioSource = $('audioSource');
const videoSource = $('videoSource');

// --- MEDIA & SETTINGS ---
async function ensureLocalStream() {
    if (localStream) return localStream;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if(localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
        }
    } catch (e) { console.error("Media Error:", e); }
    return localStream;
}

async function getDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInput = devices.filter(d => d.kind === 'audioinput');
        const videoInput = devices.filter(d => d.kind === 'videoinput');

        if(audioSource) audioSource.innerHTML = audioInput.map(d => `<option value="${d.deviceId}">${d.label || 'Mic ' + d.deviceId.slice(0,5)}</option>`).join('');
        if(videoSource) videoSource.innerHTML = videoInput.map(d => `<option value="${d.deviceId}">${d.label || 'Cam ' + d.deviceId.slice(0,5)}</option>`).join('');
    } catch(e) { console.error(e); }
}

async function switchMedia() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    
    const audioId = audioSource ? audioSource.value : undefined;
    const videoId = videoSource ? videoSource.value : undefined;
    const constraints = {
        audio: { deviceId: audioId ? { exact: audioId } : undefined },
        video: { deviceId: videoId ? { exact: videoId } : undefined }
    };
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if(localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
        }

        // Replace tracks in ALL active peer connections
        Object.values(peers).forEach(({ pc }) => {
            const videoTrack = localStream.getVideoTracks()[0];
            const audioTrack = localStream.getAudioTracks()[0];
            const senders = pc.getSenders();
            
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            
            if (videoSender && videoTrack) videoSender.replaceTrack(videoTrack);
            if (audioSender && audioTrack) audioSender.replaceTrack(audioTrack);
        });
    } catch (e) { console.error("Switch media error:", e); }
}

if (settingsBtn) settingsBtn.addEventListener('click', async () => {
    if(!settingsPanel) return;
    settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
    if (settingsPanel.style.display === 'block') await getDevices();
});
if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => {
    if(!settingsPanel) return;
    settingsPanel.style.display = 'none';
    switchMedia(); 
});

// --- PEER CONNECTION MANAGEMENT ---

function createPeerConnection(targetId) {
    if (peers[targetId]) return peers[targetId].pc;

    console.log("Creating PC for:", targetId);
    const pc = new RTCPeerConnection(iceConfig);

    // 1. Send ICE to specific target
    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { room: currentRoom, target: targetId, candidate: e.candidate });
        }
    };

    // 2. Handle Incoming Tracks (Dynamic Video Creation)
    pc.ontrack = e => {
        console.log("Track received from:", targetId);
        const stream = e.streams[0];
        
        // Check if video element already exists
        let vid = document.getElementById(`vid-${targetId}`);
        if (!vid) {
            // Create container
            const card = document.createElement('div');
            card.className = 'video-card';
            card.id = `card-${targetId}`;
            
            const title = document.createElement('h2');
            title.textContent = `User ${targetId.substr(0,4)}`; 
            
            vid = document.createElement('video');
            vid.id = `vid-${targetId}`;
            vid.autoplay = true;
            vid.playsInline = true;
            
            card.appendChild(title);
            card.appendChild(vid);
            remoteGrid.appendChild(card);
        }
        vid.srcObject = stream;
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            removePeer(targetId);
        }
    };

    peers[targetId] = { pc: pc };
    return pc;
}

function removePeer(id) {
    if (peers[id]) {
        peers[id].pc.close();
        delete peers[id];
    }
    const card = document.getElementById(`card-${id}`);
    if (card) card.remove();
}

// --- CALLING LOGIC ---

// 1. CALL SINGLE USER
window.callUser = async (targetId) => {
    if (!currentRoom) return;
    console.log("Calling:", targetId);
    
    const stream = await ensureLocalStream();
    const pc = createPeerConnection(targetId);
    
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('webrtc-offer', { room: currentRoom, target: targetId, sdp: offer });
    hangupBtn.disabled = false;
};

// 2. CALL ALL
if(callAllBtn) callAllBtn.addEventListener('click', () => {
    const userItems = document.querySelectorAll('.user-item');
    userItems.forEach(item => {
        const id = item.dataset.id;
        if (id && id !== myId) callUser(id);
    });
});

// --- SIGNALING EVENTS ---

socket.on('webrtc-offer', async ({ sdp, from, name }) => {
    console.log("Received Offer from:", from);
    const stream = await ensureLocalStream();
    
    const pc = createPeerConnection(from);
    
    // Update name UI
    setTimeout(() => {
        const card = document.getElementById(`card-${from}`);
        if(card) card.querySelector('h2').textContent = name || 'Peer';
    }, 500);

    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.emit('webrtc-answer', { room: currentRoom, target: from, sdp: answer });
    hangupBtn.disabled = false;
});

socket.on('webrtc-answer', async ({ sdp, from }) => {
    console.log("Received Answer from:", from);
    const peer = peers[from];
    if (peer && peer.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
});

socket.on('webrtc-ice-candidate', async ({ candidate, from }) => {
    const peer = peers[from];
    if (peer && peer.pc) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
});

// --- UI HELPERS ---

// Tabs
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    if (tab === 'chat') { $('tabChatBtn').classList.add('active'); $('tabContentChat').classList.add('active'); }
    if (tab === 'files') { $('tabFilesBtn').classList.add('active'); $('tabContentFiles').classList.add('active'); }
    if (tab === 'users') { $('tabUsersBtn').classList.add('active'); $('tabContentUsers').classList.add('active'); }
}
$('tabChatBtn').addEventListener('click', () => switchTab('chat'));
$('tabFilesBtn').addEventListener('click', () => switchTab('files'));
$('tabUsersBtn').addEventListener('click', () => switchTab('users'));

// Room Updates & Buttons
socket.on('room-update', ({ users, ownerId, locked }) => {
    const list = $('userList');
    list.innerHTML = '';
    
    // Host Controls
    iAmHost = (myId === ownerId);
    const hostControls = $('hostControls');
    const lockRoomBtn = $('lockRoomBtn');
    if (hostControls) hostControls.style.display = iAmHost ? 'block' : 'none';
    if (lockRoomBtn) {
        lockRoomBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
        lockRoomBtn.onclick = () => socket.emit('lock-room', !locked);
    }

    users.forEach(u => {
        const isMe = u.id === myId;
        const isOwner = u.id === ownerId;
        const div = document.createElement('div');
        div.className = 'user-item';
        div.dataset.id = u.id;
        
        let btns = '';
        if(!isMe) {
            btns = `<div class="user-actions">
               <button class="action-btn call" onclick="callUser('${u.id}')">📞 Call</button>
               <button class="action-btn ring" onclick="socket.emit('ring-user', '${u.id}')">🔔</button>
               ${iAmHost ? `<button class="action-btn kick" onclick="kickUser('${u.id}')">🦵</button>` : ''}
             </div>`;
        }
        
        div.innerHTML = `<span>${isOwner ? '👑 ' : ''}${u.name} ${isMe?'(You)':''}</span> ${btns}`;
        list.appendChild(div);
    });
});

// Globals for onclicks
window.kickUser = (id) => { if(confirm('Kick user?')) socket.emit('kick-user', id); };

// Connect / Join
joinBtn.addEventListener('click', () => {
    currentRoom = $('roomInput').value;
    userName = $('nameInput').value || 'Anon';
    socket.connect();
    socket.emit('join-room', { room: currentRoom, name: userName });
});

socket.on('connect', () => { myId = socket.id; $('signalStatus').className = 'status-dot status-connected'; $('signalStatus').textContent = 'Connected'; });
socket.on('disconnect', () => { $('signalStatus').className = 'status-dot status-disconnected'; $('signalStatus').textContent = 'Disconnected'; });

// Alerts
socket.on('kicked', () => { alert('You have been kicked.'); window.location.reload(); });
socket.on('ring-alert', ({ from }) => alert(`🔔 ${from} is calling you!`));
socket.on('room-error', (msg) => { alert(msg); });

// Hangup
hangupBtn.addEventListener('click', () => {
    Object.keys(peers).forEach(id => removePeer(id));
    if(localStream) localStream.getTracks().forEach(t => t.stop());
    localVideo.srcObject = null;
    localStream = null;
    hangupBtn.disabled = true;
});

// Chat
socket.on('chat-message', ({ name, text, isOwner }) => {
    const d = document.createElement('div');
    d.className = 'chat-line';
    const nameHtml = isOwner ? `<span style="color:#ffae00">👑 ${name}</span>` : `<strong>${name}</strong>`;
    d.innerHTML = `${nameHtml}: ${text}`;
    $('chatLog').appendChild(d);
});
$('sendBtn').addEventListener('click', () => {
    const txt = $('chatInput').value;
    if(txt) socket.emit('chat-message', { room: currentRoom, name: userName, text: txt });
    $('chatInput').value = '';
});

// Emoji
const emojiStrip = $('emojiStrip');
if (emojiStrip) {
    emojiStrip.addEventListener('click', e => {
        if (e.target.classList.contains('emoji')) {
            const chatInput = $('chatInput');
            chatInput.value += e.target.textContent;
            chatInput.focus();
        }
    });
}

// Files
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');
const fileLog = $('fileLog');

if (fileInput && sendFileBtn) {
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        fileNameLabel.textContent = file ? file.name : 'No file';
        sendFileBtn.disabled = !file;
    });
    sendFileBtn.addEventListener('click', () => {
        const file = fileInput.files[0];
        if (!file || !currentRoom) return;
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            socket.emit('file-share', { room: currentRoom, name: userName, fileName: file.name, fileType: file.type, fileData: base64 });
            appendFileLog('You', file.name, `data:${file.type};base64,${base64}`);
            fileInput.value = ''; fileNameLabel.textContent = 'No file'; sendFileBtn.disabled = true;
            switchTab('files');
        };
        reader.readAsDataURL(file);
    });
}
function appendFileLog(name, fileName, href) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<div><div style="font-weight:bold; color:var(--accent);">${fileName}</div><div style="font-size:0.7rem;">From: ${name}</div></div><a href="${href}" download="${fileName}" class="btn small primary">Download</a>`;
    fileLog.appendChild(item);
}
socket.on('file-share', ({ name, fileName, fileType, fileData }) => {
    appendFileLog(name, fileName, `data:${fileType};base64,${fileData}`);
});

// Toggle Buttons
if (toggleCamBtn) {
    toggleCamBtn.addEventListener('click', () => {
        if (!localStream) return;
        const v = localStream.getVideoTracks()[0];
        v.enabled = !v.enabled;
        toggleCamBtn.textContent = v.enabled ? 'Camera Off' : 'Camera On';
    });
}
if (toggleMicBtn) {
    toggleMicBtn.addEventListener('click', () => {
        if (!localStream) return;
        const a = localStream.getAudioTracks()[0];
        a.enabled = !a.enabled;
        toggleMicBtn.textContent = a.enabled ? 'Mute' : 'Unmute';
    });
}
if (shareScreenBtn) {
    shareScreenBtn.addEventListener('click', async () => {
        if (!currentRoom) return alert('Join room first');
        
        if (!isScreenSharing) {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
                const track = screenStream.getVideoTracks()[0];
                
                // Replace tracks in ALL peers
                Object.values(peers).forEach(({ pc }) => {
                   const sender = pc.getSenders().find(s => s.track.kind === 'video');
                   if (sender) sender.replaceTrack(track);
                });
                
                localVideo.srcObject = screenStream;
                isScreenSharing = true;
                shareScreenBtn.textContent = 'Stop Screen';
                
                track.onended = () => {
                     // Revert
                     isScreenSharing = false;
                     shareScreenBtn.textContent = 'Share Screen';
                     switchMedia(); // Switch back to cam
                };
            } catch (e) { console.error(e); }
        } else {
            // Stop sharing
            if (screenStream) screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
            isScreenSharing = false;
            shareScreenBtn.textContent = 'Share Screen';
            switchMedia();
        }
    });
}
