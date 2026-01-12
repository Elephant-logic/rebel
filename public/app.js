const socket = io({ autoConnect: false });

// --- CONFIG ---
const iceConfig = (typeof ICE_SERVERS !== 'undefined') 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- STATE ---
let myRoom = null;
let myName = 'Anon';
let localStream = null;
let peers = {}; // { socketId: { pc, name, calling: boolean } }
let currentCamId = null; // For settings
let currentMicId = null;
let facingMode = 'user'; // 'user' (front) or 'environment' (back)

// --- DOM ELEMENTS ---
const el = (id) => document.getElementById(id);
const localVideo = el('localVideo');
const videoGrid = el('videoGrid');
const userList = el('userList');
const chatLog = el('chatLog');

// ============================================
// 1. SETTINGS & CAMERA HANDLING
// ============================================

// Initialize Devices for Settings Modal
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
    } catch(e) { console.error("Device Enum Error", e); }
}

// Start/Restart Camera
async function startCamera(initial = false) {
    // Stop existing
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
        audio: currentMicId ? { deviceId: { exact: currentMicId } } : true,
        video: currentCamId 
            ? { deviceId: { exact: currentCamId } } 
            : { facingMode: facingMode } // Use facing mode if no specific ID
    };

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
        localVideo.muted = true; // Always mute local
        
        // If we are already in calls, replace tracks for peers
        Object.values(peers).forEach(({ pc }) => {
            if(pc && pc.signalingState !== 'closed') {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if(sender) sender.replaceTrack(localStream.getVideoTracks()[0]);
                const audioSender = pc.getSenders().find(s => s.track.kind === 'audio');
                if(audioSender) audioSender.replaceTrack(localStream.getAudioTracks()[0]);
            }
        });

    } catch (e) {
        console.error("Camera Start Error", e);
        alert("Camera Error: " + e.message);
    }
}

// Settings UI
el('settingsBtn').onclick = () => {
    el('settingsModal').style.display = 'flex';
    loadDevices();
};
el('closeSettings').onclick = () => {
    currentCamId = el('camSelect').value;
    currentMicId = el('micSelect').value;
    el('settingsModal').style.display = 'none';
    startCamera(); // Restart with new settings
};

// Flip Camera (Mobile)
el('flipCamBtn').onclick = () => {
    facingMode = (facingMode === 'user') ? 'environment' : 'user';
    currentCamId = null; // Clear specific ID to allow facingMode to work
    startCamera();
};

// Mute/Video Toggle
el('muteBtn').onclick = () => {
    if(!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    el('muteBtn').textContent = track.enabled ? '🎤' : '🔇';
};
el('videoBtn').onclick = () => {
    if(!localStream) return;
    const track = localStream.getVideoTracks()[0];
    track.enabled = !track.enabled;
    el('videoBtn').textContent = track.enabled ? '📷' : '⬛';
};

// ============================================
// 2. ROOM & CONNECTION LOGIC
// ============================================

el('joinBtn').onclick = async () => {
    const room = el('roomInput').value.trim();
    myName = el('nameInput').value.trim() || 'Anon';
    if (!room) return alert("Enter Room Name");
    
    // UI Updates
    el('joinPanel').classList.add('hidden');
    el('userPanel').classList.remove('hidden');
    el('roomDisplay').textContent = `Room: ${room} | You: ${myName}`;
    el('statusDot').textContent = "ONLINE";
    el('statusDot').className = "status-dot connected";

    // Start Cam
    await startCamera(true);

    // Socket Join
    myRoom = room;
    socket.connect();
    socket.emit('join-room', { room, name: myName });
};

// Handle User List & Calling
socket.on('room-users', (users) => {
    // Full list refresh (happens on join)
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

    const row = document.createElement('div');
    row.className = 'user-item';
    row.id = `user_${id}`;
    row.innerHTML = `
        <span>${name}</span>
        <div style="display:flex; gap:5px;">
            <button class="btn primary small" onclick="callUser('${id}')">📞 Call</button>
            <button class="btn small" onclick="streamToUser('${id}')">📡 Stream</button>
        </div>
    `;
    userList.appendChild(row);
}

function removeUser(id) {
    const row = document.getElementById(`user_${id}`);
    if (row) row.remove();
    // Cleanup Peer
    if (peers[id]) {
        peers[id].pc.close();
        delete peers[id];
    }
    // Cleanup Video
    const vid = document.getElementById(`vidWrap_${id}`);
    if (vid) vid.remove();
}

// ============================================
// 3. WEBRTC (CALLING & STREAMING)
// ============================================

// Triggered by the "Call" button in User List
window.callUser = (targetId) => {
    initiatePeer(targetId, true); // true = Call (Send & Receive)
};

window.streamToUser = (targetId) => {
    initiatePeer(targetId, false); // false = Stream (Send Only)
};

async function initiatePeer(targetId, isCall) {
    if (peers[targetId]) return alert("Already connected!");
    
    appendChat("System", isCall ? "Calling..." : "Starting Stream...");
    
    const pc = createPeerConnection(targetId);
    
    // Add My Tracks
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    
    // Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Send Offer
    socket.emit('webrtc-offer', {
        target: targetId,
        sdp: offer,
        isCallMode: isCall
    });
}

function createPeerConnection(targetId) {
    const pc = new RTCPeerConnection(iceConfig);
    peers[targetId] = { pc, id: targetId };

    // Handle Incoming Streams
    pc.ontrack = (event) => {
        const stream = event.streams[0];
        let vidWrap = document.getElementById(`vidWrap_${targetId}`);
        
        if (!vidWrap) {
            vidWrap = document.createElement('div');
            vidWrap.id = `vidWrap_${targetId}`;
            vidWrap.className = 'video-card';
            vidWrap.innerHTML = `
                <video autoplay playsinline></video>
                <div class="card-overlay"><span>User</span></div>
            `;
            videoGrid.appendChild(vidWrap);
        }
        vidWrap.querySelector('video').srcObject = stream;
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', {
                target: targetId,
                candidate: event.candidate
            });
        }
    };

    return pc;
}

// Handle Incoming Offer
socket.on('webrtc-offer', async ({ sender, name, sdp, isCallMode }) => {
    appendChat("System", `Incoming ${isCallMode ? 'Call' : 'Stream'} from ${name}`);
    
    const pc = createPeerConnection(sender);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // If it's a CALL, we answer with OUR video. 
    // If it's just a Stream, we don't add tracks, we just watch.
    if (isCallMode && localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
        target: sender,
        sdp: answer
    });
});

socket.on('webrtc-answer', async ({ sender, sdp }) => {
    if (peers[sender]) {
        await peers[sender].pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
});

socket.on('webrtc-ice-candidate', async ({ sender, candidate }) => {
    if (peers[sender]) {
        await peers[sender].pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
});

// ============================================
// 4. CHAT & UTILS
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

// File Share (Simple Base64 for stability)
el('fileBtn').onclick = () => el('fileInput').click();
el('fileInput').onchange = (e) => {
    const f = e.target.files[0];
    if(!f) return;
    
    const reader = new FileReader();
    reader.onload = () => {
        socket.emit('file-share', {
            room: myRoom,
            name: myName,
            fileName: f.name,
            fileData: reader.result
        });
        appendChat('You', `Sent: ${f.name}`);
    };
    reader.readAsDataURL(f);
};

socket.on('file-share', ({ name, fileName, fileData }) => {
    const link = `<a href="${fileData}" download="${fileName}" style="color:var(--primary)">💾 ${fileName}</a>`;
    appendChat(name, `Shared ${link}`);
});
