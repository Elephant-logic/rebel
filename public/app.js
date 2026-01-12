// HOST & P2P CLIENT
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'Host';
let myId = null; // Store our socket ID

let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// ICE config
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

// Tabs
const tabChatBtn = $('tabChatBtn');
const tabFilesBtn = $('tabFilesBtn');
const tabUsersBtn = $('tabUsersBtn');
const tabContentChat = $('tabContentChat');
const tabContentFiles = $('tabContentFiles');
const tabContentUsers = $('tabContentUsers');

// Chat, Files, Users
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const emojiStrip = $('emojiStrip');
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');
const fileLog = $('fileLog');
const userList = $('userList');


// --- UI HELPERS ---
function setSignal(connected) {
    if (!signalStatus) return;
    signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
    signalStatus.className = connected ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

// Tab Switching
function switchTab(tab) {
    // Reset all
    [tabChatBtn, tabFilesBtn, tabUsersBtn].forEach(b => b && b.classList.remove('active'));
    [tabContentChat, tabContentFiles, tabContentUsers].forEach(c => c && c.classList.remove('active'));
    
    // Activate specific
    if (tab === 'chat') {
        tabChatBtn.classList.add('active');
        tabContentChat.classList.add('active');
    } else if (tab === 'files') {
        tabFilesBtn.classList.add('active');
        tabContentFiles.classList.add('active');
    } else if (tab === 'users') {
        tabUsersBtn.classList.add('active');
        tabContentUsers.classList.add('active');
    }
}
if(tabChatBtn) tabChatBtn.addEventListener('click', () => switchTab('chat'));
if(tabFilesBtn) tabFilesBtn.addEventListener('click', () => switchTab('files'));
if(tabUsersBtn) tabUsersBtn.addEventListener('click', () => switchTab('users'));


// --- CHAT & USER LIST LOGIC ---

// Simple list management
const activeUsers = new Map(); // id -> name

function addToUserList(id, name, isMe = false) {
    if (!userList) return;
    if (activeUsers.has(id)) return; // Already in list
    
    activeUsers.set(id, name);
    
    const div = document.createElement('div');
    div.id = `user-${id}`;
    div.className = isMe ? 'user-item is-me' : 'user-item';
    
    // Check for crown in name
    const displayName = name.includes('👑') ? name : name; 
    
    div.innerHTML = `
        <span style="font-weight:bold; color: ${isMe ? 'var(--accent)' : 'inherit'}">
            ${displayName} ${isMe ? '(You)' : ''}
        </span>
        <span class="status-dot status-connected" style="padding:2px 6px; font-size:0.6rem;">Active</span>
    `;
    userList.appendChild(div);
}

function removeFromUserList(id) {
    if (!userList) return;
    activeUsers.delete(id);
    const div = document.getElementById(`user-${id}`);
    if (div) div.remove();
}

function appendChat(name, text, ts = Date.now()) {
    if (!chatLog) return;
    const line = document.createElement('div');
    line.className = 'chat-line';
    const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Highlight name if it has crown or is 'You'
    let nameHtml = `<strong>${name}</strong>`;
    if (name === 'You' || name.includes('You')) {
        nameHtml = `<span style="color:#4af3a3">${name}</span>`;
    } else if (name.includes('👑')) {
        nameHtml = `<span style="color:#ffae00">${name}</span>`;
    }
    
    line.innerHTML = `${nameHtml} <small>${t}</small>: ${text}`;
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
    appendChat(name, `Shared a file: ${fileName} (See Files tab)`);
}

async function ensureLocalStream() {
    if (localStream) return localStream;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
        }
    } catch (e) { console.error("Media Error", e); }
    return localStream;
}

// --- WEBRTC ---
function createPC() {
    if (pc) { try { pc.close(); } catch (e) {} }
    pc = new RTCPeerConnection(iceConfig);
    
    pc.onicecandidate = e => {
        if (e.candidate && currentRoom) {
            socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
        }
    };
    
    pc.ontrack = (event) => {
        if (remoteVideo) remoteVideo.srcObject = event.streams[0];
    };
    
    return pc;
}

// HOST START
async function startBroadcast() {
    if (!currentRoom) return alert('Join a room first');
    
    // CROWN LOGIC: Add crown to name if not present
    if (!userName.includes('👑')) {
        userName = '👑 ' + userName;
        // Update local display
        removeFromUserList(myId);
        addToUserList(myId, userName, true);
    }
    
    const stream = isScreenSharing && screenStream ? screenStream : await ensureLocalStream();
    createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
    
    if (startCallBtn) { startCallBtn.disabled = true; startCallBtn.textContent = 'Calling...'; }
    if (hangupBtn) hangupBtn.disabled = false;
}

// LISTENERS
socket.on('webrtc-offer', async ({ sdp }) => {
    if (!currentRoom) return;
    // Auto-answer logic
    const stream = await ensureLocalStream();
    if (!pc) createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.emit('webrtc-answer', { room: currentRoom, sdp: answer });
    
    if (startCallBtn) { startCallBtn.disabled = true; startCallBtn.textContent = 'In Call'; }
    if (hangupBtn) hangupBtn.disabled = false;
});

socket.on('webrtc-answer', async ({ sdp }) => {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    if (startCallBtn) startCallBtn.textContent = 'In Call';
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

function stopCall() {
    if (pc) { pc.close(); pc = null; }
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    isScreenSharing = false;
    if (startCallBtn) { startCallBtn.disabled = false; startCallBtn.textContent = 'Start Call'; }
    if (hangupBtn) hangupBtn.disabled = true;
}

// --- DOM EVENT LISTENERS ---
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
        
        const url = new URL(window.location.href);
        url.pathname = '/view.html'; 
        url.search = `?room=${encodeURIComponent(room)}`;
        if (streamLinkInput) streamLinkInput.value = url.toString();
    });
}
if (leaveBtn) leaveBtn.addEventListener('click', () => window.location.reload());
if (startCallBtn) startCallBtn.addEventListener('click', () => startBroadcast().catch(console.error));
if (startStreamBtn) startStreamBtn.addEventListener('click', () => startBroadcast().catch(console.error));
if (hangupBtn) hangupBtn.addEventListener('click', stopCall);

if (shareScreenBtn) {
    shareScreenBtn.addEventListener('click', async () => {
        if (!currentRoom) return alert('Join room first');
        await ensureLocalStream();
        if (!isScreenSharing) {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
                const track = screenStream.getVideoTracks()[0];
                if (pc) {
                    const sender = pc.getSenders().find(s => s.track.kind === 'video');
                    if (sender) sender.replaceTrack(track);
                }
                localVideo.srcObject = screenStream;
                isScreenSharing = true;
                shareScreenBtn.textContent = 'Stop Screen';
                track.onended = () => stopScreenShare();
            } catch (e) { console.error(e); }
        } else { stopScreenShare(); }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    if (localStream && pc) {
        const camTrack = localStream.getVideoTracks()[0];
        const sender = pc.getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(camTrack);
        localVideo.srcObject = localStream;
    }
    isScreenSharing = false;
    shareScreenBtn.textContent = 'Share Screen';
}

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
if (openStreamBtn) {
    openStreamBtn.addEventListener('click', () => {
        if (streamLinkInput && streamLinkInput.value) window.open(streamLinkInput.value, '_blank');
    });
}

// Chat & Files
socket.on('chat-message', ({ name, text, ts }) => {
    appendChat(name, text, ts);
    // If we receive chat from someone we don't have in list (and isn't us), add them loosely
    // Note: server doesn't send ID in chat-message usually, so this is best-effort visual
});

function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !currentRoom) return;
    socket.emit('chat-message', { room: currentRoom, name: userName, text });
    appendChat('You', text);
    chatInput.value = '';
}
if (sendBtn) sendBtn.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

if (emojiStrip) {
    emojiStrip.addEventListener('click', e => {
        if (e.target.classList.contains('emoji')) {
            chatInput.value += e.target.textContent;
            chatInput.focus();
        }
    });
}

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
            socket.emit('file-share', {
                room: currentRoom, name: userName, fileName: file.name, fileType: file.type, fileData: base64
            });
            appendFileLog('You', file.name, `data:${file.type};base64,${base64}`);
            fileInput.value = ''; fileNameLabel.textContent = 'No file'; sendFileBtn.disabled = true;
            switchTab('files');
        };
        reader.readAsDataURL(file);
    });
}
socket.on('file-share', ({ name, fileName, fileType, fileData }) => {
    appendFileLog(name, fileName, `data:${fileType};base64,${fileData}`);
});

// SOCKET EVENTS FOR USER LIST
socket.on('connect', () => {
    setSignal(true);
    myId = socket.id;
});
socket.on('disconnect', () => {
    setSignal(false);
    if(userList) userList.innerHTML = '';
});

// When ANY user joins (including us after server ack, typically)
socket.on('user-joined', ({ id, name }) => {
    addToUserList(id, name, id === myId);
    if (id !== myId) appendChat('System', `${name} joined.`);
});
socket.on('user-left', ({ id }) => {
    removeFromUserList(id);
});

// Self-add on join (since server might only echo to others)
socket.on('join-room', () => {
    addToUserList(myId, userName, true);
});
