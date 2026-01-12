// HOST & P2P CLIENT
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';

let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// ICE config (uses config/ice.js if available)
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? {
    iceServers: ICE_SERVERS
} : {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// --- DOM ELEMENTS ---
const $ = id => document.getElementById(id);

// Connection & Room
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const signalStatus = $('signalStatus');
const roomInfo = $('roomInfo');

// Media & Calls
const startCallBtn = $('startCallBtn');
const startStreamBtn = $('startStreamBtn');
const hangupBtn = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const localVideo = $('localVideo');
const remoteVideo = $('remoteVideo'); 
const streamLinkInput = $('streamLinkInput');
const openStreamBtn = $('openStreamBtn');

// Tabs & Panels
const tabChatBtn = $('tabChatBtn');
const tabFilesBtn = $('tabFilesBtn');
const tabContentChat = $('tabContentChat');
const tabContentFiles = $('tabContentFiles');

// Chat & Files
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const emojiStrip = $('emojiStrip');
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');
const fileLog = $('fileLog');


// --- UI HELPERS ---
function setSignal(connected) {
    if (!signalStatus) return;
    signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
    signalStatus.className = connected ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

// Tab Switching
function switchTab(tab) {
    if (tab === 'chat') {
        tabChatBtn.classList.add('active');
        tabFilesBtn.classList.remove('active');
        tabContentChat.classList.add('active');
        tabContentFiles.classList.remove('active');
    } else {
        tabFilesBtn.classList.add('active');
        tabChatBtn.classList.remove('active');
        tabContentFiles.classList.add('active');
        tabContentChat.classList.remove('active');
    }
}
if(tabChatBtn) tabChatBtn.addEventListener('click', () => switchTab('chat'));
if(tabFilesBtn) tabFilesBtn.addEventListener('click', () => switchTab('files'));

function appendChat(name, text, ts = Date.now()) {
    if (!chatLog) return;
    const line = document.createElement('div');
    line.className = 'chat-line';
    const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who = name === 'You' ? `<span style="color:#4af3a3">${name}</span>` : `<strong>${name}</strong>`;
    line.innerHTML = `${who} <small>${t}</small>: ${text}`;
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function appendFileLog(name, fileName, href) {
    if (!fileLog) return;
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
        <div>
            <div style="font-weight:bold; color:var(--accent);">${fileName}</div>
            <div style="font-size:0.7rem; color:var(--muted);">From: ${name}</div>
        </div>
        <a href="${href}" download="${fileName}" class="btn small primary">Download</a>
    `;
    fileLog.appendChild(item);
    
    // Also notify in chat
    appendChat(name, `Shared a file: ${fileName} (See Files tab)`);
}

async function ensureLocalStream() {
    if (localStream) return localStream;
    userName = (nameInput && nameInput.value.trim()) || 'Host';
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true; // Mute local to avoid echo
        }
    } catch (e) {
        console.error("Error accessing media", e);
    }
    return localStream;
}

// --- WEBRTC CORE (HOST & PEER) ---

function createPC() {
    if (pc) { try { pc.close(); } catch (e) {} }
    
    pc = new RTCPeerConnection(iceConfig);

    // Send ICE candidates to the room
    pc.onicecandidate = e => {
        if (e.candidate && currentRoom) {
            socket.emit('webrtc-ice-candidate', {
                room: currentRoom,
                candidate: e.candidate
            });
        }
    };

    // When remote stream arrives
    pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (remoteVideo) {
            remoteVideo.srcObject = stream;
        }
    };

    pc.onconnectionstatechange = () => {
        if (!pc) return;
        console.log('PC State:', pc.connectionState);
    };

    return pc;
}

// 1. INITIATOR LOGIC (Start Call / Stream)
async function startBroadcast() {
    if (!currentRoom) return alert('Join a room first');
    
    const stream = isScreenSharing && screenStream ? screenStream : await ensureLocalStream();
    createPC();

    // Add tracks to PC
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('webrtc-offer', {
        room: currentRoom,
        sdp: offer
    });

    if (startCallBtn) {
        startCallBtn.disabled = true;
        startCallBtn.textContent = 'Calling...';
    }
    if (hangupBtn) hangupBtn.disabled = false;
}

// 2. RECEIVER LOGIC (The "Call Back" Fix)
// This listens for an incoming offer, accepts it, and sends video back automatically.
socket.on('webrtc-offer', async ({ sdp }) => {
    if (!currentRoom) return; 

    // Auto-answer logic
    console.log("Received Offer - Auto Answering");
    const stream = await ensureLocalStream(); // Make sure we have camera ready
    
    if (!pc) createPC(); // Create PC if doesn't exist

    // Add our video to the answer (so they see us)
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('webrtc-answer', {
            room: currentRoom,
            sdp: answer
        });

        // Update UI
        if (startCallBtn) {
            startCallBtn.disabled = true;
            startCallBtn.textContent = 'In Call';
        }
        if (hangupBtn) hangupBtn.disabled = false;
    } catch(e) {
        console.error("Error auto-answering:", e);
    }
});


// Answer handling (Caller receives Answer)
socket.on('webrtc-answer', async ({ sdp }) => {
    if (!pc || !sdp) return;
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (startCallBtn) startCallBtn.textContent = 'In Call';
    } catch (e) { console.error(e); }
});

// ICE handling
socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } 
    catch (e) { console.error(e); }
});

function stopCall() {
    if (pc) {
        pc.close();
        pc = null;
    }
    // Stop tracks
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    
    isScreenSharing = false;
    
    if (startCallBtn) {
        startCallBtn.disabled = false;
        startCallBtn.textContent = 'Start Call';
    }
    if (hangupBtn) hangupBtn.disabled = true;
}

// --- BUTTON LISTENERS ---

if (joinBtn) {
    joinBtn.addEventListener('click', () => {
        const room = roomInput.value.trim();
        if (!room) return alert('Enter room');
        currentRoom = room;
        userName = nameInput.value.trim() || 'Anon';
        socket.connect();
        socket.emit('join-room', { room: currentRoom, name: userName });
        
        joinBtn.disabled = true;
        leaveBtn.disabled = false;
        roomInfo.textContent = `Room: ${room}`;
        
        // Setup View Link
        const url = new URL(window.location.href);
        // Assuming view.html is in same dir, or we just want a link for the current page
        // But for the stream viewer, it's usually view.html
        url.pathname = '/view.html'; 
        url.search = `?room=${encodeURIComponent(room)}`;
        if (streamLinkInput) streamLinkInput.value = url.toString();
    });
}

if (leaveBtn) leaveBtn.addEventListener('click', () => window.location.reload());

// Both buttons do the same thing now (initiate broadcast/call)
if (startCallBtn) startCallBtn.addEventListener('click', () => startBroadcast().catch(console.error));
if (startStreamBtn) startStreamBtn.addEventListener('click', () => startBroadcast().catch(console.error));

if (hangupBtn) hangupBtn.addEventListener('click', stopCall);

// Screen Share
if (shareScreenBtn) {
    shareScreenBtn.addEventListener('click', async () => {
        if (!currentRoom) return alert('Join room first');
        await ensureLocalStream();
        
        if (!isScreenSharing) {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
                const track = screenStream.getVideoTracks()[0];
                
                // If in call, replace track
                if (pc) {
                    const sender = pc.getSenders().find(s => s.track.kind === 'video');
                    if (sender) sender.replaceTrack(track);
                }
                
                localVideo.srcObject = screenStream;
                isScreenSharing = true;
                shareScreenBtn.textContent = 'Stop Screen';
                
                track.onended = () => stopScreenShare();
            } catch (e) { console.error(e); }
        } else {
            stopScreenShare();
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    
    // Revert to cam
    if (localStream && pc) {
        const camTrack = localStream.getVideoTracks()[0];
        const sender = pc.getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(camTrack);
        localVideo.srcObject = localStream;
    }
    isScreenSharing = false;
    shareScreenBtn.textContent = 'Share Screen';
}

// Toggles
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

// Open Stream Link
if (openStreamBtn) {
    openStreamBtn.addEventListener('click', () => {
        if (!streamLinkInput || !streamLinkInput.value) return;
        window.open(streamLinkInput.value, '_blank');
    });
}

// Chat
socket.on('chat-message', ({ name, text, ts }) => appendChat(name, text, ts));

function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !currentRoom) return;
    socket.emit('chat-message', { room: currentRoom, name: userName, text });
    appendChat('You', text);
    chatInput.value = '';
}
if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// Emoji
if (emojiStrip) {
    emojiStrip.addEventListener('click', e => {
        if (e.target.classList.contains('emoji')) {
            chatInput.value += e.target.textContent;
            chatInput.focus();
        }
    });
}

// Files
if (fileInput && sendFileBtn) {
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        fileNameLabel.textContent = file ? file.name : 'No file selected';
        sendFileBtn.disabled = !file;
    });

    sendFileBtn.addEventListener('click', () => {
        const file = fileInput.files[0];
        if (!file || !currentRoom) return;
        
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            socket.emit('file-share', {
                room: currentRoom,
                name: userName,
                fileName: file.name,
                fileType: file.type,
                fileData: base64
            });
            // Add to own log
            const href = `data:${file.type};base64,${base64}`;
            appendFileLog('You', file.name, href);
            
            fileInput.value = '';
            fileNameLabel.textContent = 'No file selected';
            sendFileBtn.disabled = true;
            
            // Switch to files tab to show it
            switchTab('files');
        };
        reader.readAsDataURL(file);
    });
}

socket.on('file-share', ({ name, fileName, fileType, fileData }) => {
    const href = `data:${fileType};base64,${fileData}`;
    appendFileLog(name, fileName, href);
});

// Socket Status
socket.on('connect', () => setSignal(true));
socket.on('disconnect', () => setSignal(false));
