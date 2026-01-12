const socket = io({ autoConnect: false });

// --- CONFIG ---
const iceConfig = (typeof ICE_SERVERS !== 'undefined') 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- STATE ---
let myRoom = null;
let myName = 'Anon';
let localStream = null;
let peers = {}; // Stores connections: { [socketId]: { pc, id } }
let currentCamId = null;
let currentMicId = null;
let facingMode = 'user'; // 'user' (front) or 'environment' (back)

// --- DOM ELEMENTS ---
const el = (id) => document.getElementById(id);
const localVideo = el('localVideo');
const videoGrid = el('videoGrid');
const userList = el('userList');
const chatLog = el('chatLog');

// ============================================
// 1. INITIALIZATION & SETTINGS
// ============================================

// Check URL for room on load
window.addEventListener('load', () => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('room');
    if (r) el('roomInput').value = r;
});

// Load Audio/Video Devices
async function loadDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = el('camSelect');
        const mics = el('micSelect');
        cams.innerHTML = ''; mics.innerHTML = '';
        
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} (${d.deviceId.slice(0,4)}...)`;
            if(d.kind === 'videoinput') cams.appendChild(opt);
            if(d.kind === 'audioinput') mics.appendChild(opt);
        });
    } catch(e) { console.error("Device Error", e); }
}

// Start Camera
async function startCamera() {
    // Stop old tracks
    if (localStream) localStream.getTracks().forEach(t => t.stop());

    const constraints = {
        audio: currentMicId ? { deviceId: { exact: currentMicId } } : true,
        video: currentCamId 
            ? { deviceId: { exact: currentCamId } } 
            : { facingMode: facingMode }
    };

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
        localVideo.muted = true; // Mute self
        
        // Update active connections
        Object.values(peers).forEach(({ pc }) => {
            if(pc && pc.signalingState !== 'closed') {
                const videoSender = pc.getSenders().find(s => s.track.kind === 'video');
                const audioSender = pc.getSenders().find(s => s.track.kind === 'audio');
                if(videoSender) videoSender.replaceTrack(localStream.getVideoTracks()[0]);
                if(audioSender) audioSender.replaceTrack(localStream.getAudioTracks()[0]);
            }
        });
    } catch (e) {
        alert("Camera Error: " + e.message);
    }
}

// Settings UI Events
el('settingsBtn').onclick = () => { el('settingsModal').style.display = 'flex'; loadDevices(); };
el('closeSettings').onclick = () => {
    currentCamId = el('camSelect').value;
    currentMicId = el('micSelect').value;
    el('settingsModal').style.display = 'none';
    startCamera();
};
el('flipCamBtn').onclick = () => {
    facingMode = (facingMode === 'user') ? 'environment' : 'user';
    currentCamId = null; // Reset specific ID to use facing mode
    startCamera();
};
el('muteBtn').onclick = () => {
    if(!localStream) return;
    const t = localStream.getAudioTracks()[0];
    t.enabled = !t.enabled;
    el('muteBtn').textContent = t.enabled ? '🎤' : '🔇';
};
el('videoBtn').onclick = () => {
    if(!localStream) return;
    const t = localStream.getVideoTracks()[0];
    t.enabled = !t.enabled;
    el('videoBtn').textContent = t.enabled ? '📷' : '⬛';
};

// ============================================
// 2. JOIN ROOM
// ============================================

el('joinBtn').onclick = async () => {
    const room = el('roomInput').value.trim();
    myName = el('nameInput').value.trim() || 'Anon';
    if (!room) return alert("Enter Room Name");
    
    // UI Updates
    el('joinPanel').classList.add('hidden');
    el('userPanel').classList.remove('hidden');
    el('roomDisplay').textContent = `Room: ${room}`;
    el('statusDot').textContent = "ONLINE";
    el('statusDot').className = "status-dot connected";

    // Generate Link
    const url = new URL(window.location.href);
    url.searchParams.set('room', room);
    el('streamLinkInput').value = url.toString();

    // Start
    await startCamera();
    myRoom = room;
    socket.connect();
    socket.emit('join-room', { room, name: myName });
};

el('copyLinkBtn').onclick = () => {
    const input = el('streamLinkInput');
    input.select();
    document.execCommand('copy');
    alert("Link Copied!");
};

// ============================================
// 3. USER LIST & CALL LOGIC
// ============================================

socket.on('room-users', (users) => {
    userList.innerHTML = '';
    users.forEach(u => {
        if(u.id !== socket.id) addUserToList(u.id, u.name);
    });
});

socket.on('user-update', ({ type, id, name }) => {
    if (type === 'join') {
        addUserToList(id, name);
        appendChat('System', `${name} joined.`);
    } else if (type === 'leave') {
        removeUser(id);
        appendChat('System', `User left.`);
    }
});

function addUserToList(id, name) {
    if(document.getElementById(`user_${id}`)) return;
    const div = document.createElement('div');
    div.className = 'user-item';
    div.id = `user_${id}`;
    div.innerHTML = `
        <span>${name}</span>
        <div class="user-actions">
            <button class="btn primary small" onclick="callUser('${id}')">📞 Call</button>
            <button class="btn small" onclick="streamToUser('${id}')">📡 Stream</button>
        </div>
    `;
    userList.appendChild(div);
}

function removeUser(id) {
    const div = document.getElementById(`user_${id}`);
    if (div) div.remove();
    // Cleanup Video
    const vid = document.getElementById(`vidWrap_${id}`);
    if (vid) vid.remove();
    // Cleanup Peer
    if (peers[id]) { peers[id].pc.close(); delete peers[id]; }
}

// ============================================
// 4. WEBRTC (The Core)
// ============================================

// CALL: Bidirectional (You see them, they see you)
window.callUser = (targetId) => initiatePeer(targetId, true);

// STREAM: Unidirectional (They see you, you don't see them)
window.streamToUser = (targetId) => initiatePeer(targetId, false);

async function initiatePeer(targetId, isCall) {
    if (peers[targetId]) return alert("Already connected!");
    appendChat("System", isCall ? "Calling..." : "Starting Stream...");
    
    const pc = createPeerConnection(targetId);
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('webrtc-offer', { target: targetId, sdp: offer, isCallMode: isCall });
}

function createPeerConnection(targetId) {
    const pc = new RTCPeerConnection(iceConfig);
    peers[targetId] = { pc, id: targetId };

    pc.ontrack = (event) => {
        const stream = event.streams[0];
        let vidWrap = document.getElementById(`vidWrap_${targetId}`);
        if (!vidWrap) {
            vidWrap = document.createElement('div');
            vidWrap.id = `vidWrap_${targetId}`;
            vidWrap.className = 'video-card';
            vidWrap.innerHTML = `<video autoplay playsinline></video><div class="card-overlay"><span>User</span></div>`;
            videoGrid.appendChild(vidWrap);
        }
        vidWrap.querySelector('video').srcObject = stream;
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('webrtc-ice-candidate', { target: targetId, candidate: e.candidate });
    };

    return pc;
}

// Incoming Signals
socket.on('webrtc-offer', async ({ sender, name, sdp, isCallMode }) => {
    appendChat("System", `Incoming ${isCallMode ? 'Call' : 'Stream'} from ${name}`);
    
    const pc = createPeerConnection(sender);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // Only answer with video if it is a CALL
    if (isCallMode && localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { target: sender, sdp: answer });
});

socket.on('webrtc-answer', async ({ sender, sdp }) => {
    if (peers[sender]) await peers[sender].pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ sender, candidate }) => {
    if (peers[sender]) await peers[sender].pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// ============================================
// 5. CHAT & FILE
// ============================================

el('sendBtn').onclick = () => {
    const text = el('chatInput').value;
    if(!text) return;
    socket.emit('chat-message', { room: myRoom, name: myName, text });
    appendChat('You', text);
    el('chatInput').value = '';
};

socket.on('chat-message', ({ name, text }) => appendChat(name, text));

function appendChat(name, text) {
    const div = document.createElement('div');
    div.className = 'chat-line';
    div.innerHTML = `<strong>${name}:</strong> ${text}`;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
}

// File Share
el('fileBtn').onclick = () => el('fileInput').click();
el('fileInput').onchange = (e) => {
    const f = e.target.files[0];
    if(!f) return;
    const reader = new FileReader();
    reader.onload = () => {
        socket.emit('file-share', { room: myRoom, name: myName, fileName: f.name, fileData: reader.result });
        appendChat('You', `Sent: ${f.name}`);
    };
    reader.readAsDataURL(f);
};

socket.on('file-share', ({ name, fileName, fileData }) => {
    const link = `<a href="${fileData}" download="${fileName}" style="color:var(--primary)">💾 ${fileName}</a>`;
    appendChat(name, `Shared ${link}`);
});
