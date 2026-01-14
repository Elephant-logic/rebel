// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
// This handles splitting games/tools into chunks 
// and sending them securely over WebRTC to all viewers.

const CHUNK_SIZE = 16 * 1024; // 16KB chunks (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit to prevent crashes

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;

    // Create a specific data channel for the arcade
    // This runs parallel to video/audio
    const channel = pc.createDataChannel("side-load-pipe");

    channel.onopen = async () => {
        console.log(`[Arcade] Starting transfer of: ${file.name}`);

        // 1. Send Metadata (So the receiver knows what's coming)
        const metadata = JSON.stringify({
            type: 'meta', 
            name: file.name, 
            size: file.size, 
            mime: file.type 
        });
        channel.send(metadata);

        // 2. File Buffer
        const buffer = await file.arrayBuffer();
        let offset = 0;

        const sendLoop = () => {
            // Prevent large bufferedAmount from crashing the browser
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }

            if (channel.readyState !== 'open') {
                console.warn('[Arcade] DataChannel closed during transfer.');
                return;
            }

            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;

            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            if (offset < file.size) {
                setTimeout(sendLoop, 0);
            } else {
                console.log('[Arcade] Completed transfer of:', file.name);
                channel.close();
            }
        };

        sendLoop();
    };

    channel.onerror = (err) => console.error('[Arcade] DataChannel error:', err);
}


// ======================================================
// 2. CORE SOCKET & STATE
// ======================================================

const socket = io({
    autoConnect: false,
    transports: ['websocket'],
    withCredentials: true
});

const $ = (id) => document.getElementById(id);

let userName = '';
let currentRoom = null;
let isHost = false;
let myId = null;

// STREAM PC (Host → viewers)
let pc = null;
let isStreaming = false;
let broadcastStream = null;

// LOCAL MEDIA
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// CALLERS (for 1:1 or group calls separate from broadcast)
const callPeers = {};      // { socketId: { pc, stream, name } }

// VIEWER WEBRTC PEERS (broadcast connections)
const viewerPeers = {};    // { socketId: RTCPeerConnection }

// ICE configuration (STUN/TURN)
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ======================================================
// 3. UI HELPERS
// ======================================================

function logStatus(msg) {
    const el = $('statusBar');
    if (el) el.textContent = msg;
    console.log('[STATUS]', msg);
}

function safeName(name) {
    return (name || '').toString().slice(0, 30) || 'Anon';
}

function formatTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}


// ======================================================
// 4. LOGIN / PANELS / TABS
// ======================================================

function showPanel(id) {
    const panels = document.querySelectorAll('.right-panel');
    panels.forEach(p => p.classList.add('hidden'));
    const target = $(id);
    if (target) target.classList.remove('hidden');

    const tabs = document.querySelectorAll('.tab-button');
    tabs.forEach(t => t.classList.remove('active'));
    const btn = document.querySelector(`[data-panel="${id}"]`);
    if (btn) btn.classList.add('active');
}

function initTabs() {
    const tabs = document.querySelectorAll('.tab-button');
    tabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const panelId = btn.getAttribute('data-panel');
            showPanel(panelId);
        });
    });
    showPanel('chatPanel');
}

function initLogin() {
    const loginBtn = $('loginBtn');
    if (!loginBtn) return;

    loginBtn.addEventListener('click', () => {
        const name = $('nameInput').value.trim();
        const room = $('roomInput').value.trim();

        if (!name || !room) {
            alert('Please enter a name and stream ID.');
            return;
        }

        userName = name;
        currentRoom = room;
        isHost = true;

        $('loginScreen').classList.add('hidden');
        $('mainApp').classList.remove('hidden');

        $('hostNameLabel').textContent = name;
        $('roomNameLabel').textContent = room;

        socket.connect();
        socket.emit('join-room', { room, name, isHost: true });

        logStatus('Connected as Host.');
    });
}

function initViewerLink() {
    const copyBtn = $('copyViewerLink');
    if (!copyBtn) return;

    copyBtn.addEventListener('click', () => {
        const base = window.location.origin;
        const roomSlug = encodeURIComponent(currentRoom || '');
        const url = `${base}/view?room=${roomSlug}`;

        const input = $('viewerLink');
        if (input) {
            input.value = url;
            input.select();
        }

        navigator.clipboard.writeText(url)
          .then(() => logStatus('Viewer link copied to clipboard.'))
          .catch(() => logStatus('Unable to copy link automatically (copied in input).'));
    });
}


// ======================================================
// 5. STREAM SETUP (HOST → VIEWERS)
// ======================================================

async function startStream() {
    if (isStreaming) return;
    if (!currentRoom) {
        alert('Join a room first.');
        return;
    }

    try {
        // 1. Local cam/mic
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
        }

        // 2. Build broadcast stream (for now just using localStream directly)
        broadcastStream = new MediaStream();
        localStream.getTracks().forEach(t => broadcastStream.addTrack(t));

        // 3. Create PC used as "master" for broadcast
        pc = new RTCPeerConnection(iceConfig);
        broadcastStream.getTracks().forEach(track => pc.addTrack(track, broadcastStream));

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc-ice-candidate', {
                    room: currentRoom,
                    candidate: event.candidate,
                    role: 'host'
                });
            }
        };

        // 4. Ask server to create a broadcast offer (signals to all viewers)
        socket.emit('create-offer', {
            room: currentRoom,
            role: 'host'
        });

        isStreaming = true;
        $('streamState').textContent = 'LIVE';
        $('startStreamBtn').disabled = true;
        $('stopStreamBtn').disabled = false;
        logStatus('Streaming started.');
    } catch (err) {
        console.error('Failed to start stream:', err);
        logStatus('Failed to start stream (check camera/mic permissions).');
    }
}

function stopStream() {
    if (!isStreaming) return;

    if (pc) {
        pc.getSenders().forEach(s => {
            try { pc.removeTrack(s); } catch (e) {}
        });
        pc.close();
        pc = null;
    }
    Object.values(viewerPeers).forEach(vpc => {
        try { vpc.close(); } catch (e) {}
    });
    Object.keys(viewerPeers).forEach(k => delete viewerPeers[k]);

    if (broadcastStream) {
        broadcastStream.getTracks().forEach(t => t.stop());
        broadcastStream = null;
    }

    isStreaming = false;
    $('streamState').textContent = 'OFF';
    $('startStreamBtn').disabled = false;
    $('stopStreamBtn').disabled = true;
    logStatus('Stream stopped.');
}


// ======================================================
// 6. VIEWER PEER CONNECT (BROADCAST)
// ======================================================

socket.on('viewer-joined', async ({ viewerId }) => {
    // A viewer joined after stream already started → we open a dedicated RTCPeerConnection
    if (!isStreaming || !broadcastStream) return;
    if (viewerPeers[viewerId]) return;

    const viewerPc = new RTCPeerConnection(iceConfig);
    viewerPeers[viewerId] = viewerPc;

    broadcastStream.getTracks().forEach(t => viewerPc.addTrack(t, broadcastStream));

    viewerPc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', {
                room: currentRoom,
                candidate: event.candidate,
                role: 'host',
                targetId: viewerId
            });
        }
    };

    const offer = await viewerPc.createOffer();
    await viewerPc.setLocalDescription(offer);

    socket.emit('webrtc-offer', {
        room: currentRoom,
        sdp: viewerPc.localDescription,
        role: 'host',
        targetId: viewerId
    });
});

socket.on('webrtc-answer', async ({ sdp, from, role }) => {
    if (role !== 'viewer') return;
    const viewerPc = viewerPeers[from];
    if (!viewerPc) return;
    await viewerPc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate, role, from, targetId }) => {
    // For broadcast connections coming back from viewers
    if (role === 'viewer') {
        const vpc = viewerPeers[from];
        if (vpc && candidate) {
            await vpc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }
});


// ======================================================
// 7. 1:1 CALL SYSTEM (SEPARATE FROM BROADCAST)
// ======================================================

async function ensureLocalStreamForCall() {
    if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
    }
}

async function startCall(targetId) {
    await ensureLocalStreamForCall();

    const pcCall = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc: pcCall, stream: null, name: `Guest ${targetId}` };

    localStream.getTracks().forEach(t => pcCall.addTrack(t, localStream));

    pcCall.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('call-ice-candidate', {
                targetId,
                candidate: event.candidate
            });
        }
    };

    pcCall.ontrack = (event) => {
        const stream = event.streams[0];
        callPeers[targetId].stream = stream;
        attachRemoteVideo(targetId, stream);
    };

    const offer = await pcCall.createOffer();
    await pcCall.setLocalDescription(offer);

    socket.emit('call-offer', {
        targetId,
        sdp: pcCall.localDescription
    });
}

socket.on('call-offer', async ({ from, sdp, name }) => {
    await ensureLocalStreamForCall();

    const pcCall = new RTCPeerConnection(iceConfig);
    callPeers[from] = { pc: pcCall, stream: null, name: name || `Guest ${from}` };

    localStream.getTracks().forEach(t => pcCall.addTrack(t, localStream));

    pcCall.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('call-ice-candidate', {
                targetId: from,
                candidate: event.candidate
            });
        }
    };

    pcCall.ontrack = (event) => {
        const stream = event.streams[0];
        callPeers[from].stream = stream;
        attachRemoteVideo(from, stream);
    };

    await pcCall.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pcCall.createAnswer();
    await pcCall.setLocalDescription(answer);

    socket.emit('call-answer', {
        targetId: from,
        sdp: pcCall.localDescription
    });
});

socket.on('call-answer', async ({ from, sdp }) => {
    const peer = callPeers[from];
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('call-ice-candidate', async ({ from, candidate }) => {
    const peer = callPeers[from];
    if (!peer || !candidate) return;
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

function endPeerCall(targetId) {
    const peer = callPeers[targetId];
    if (!peer) return;
    if (peer.pc) {
        peer.pc.close();
    }
    delete callPeers[targetId];
    removeRemoteVideo(targetId);
}


// ======================================================
// 8. ROOM & USER MANAGEMENT
// ======================================================

socket.on('connect', () => {
    myId = socket.id;
    logStatus('Connected to signalling server.');
});

socket.on('disconnect', () => {
    logStatus('Disconnected from server.');
});

socket.on('room-users', ({ users }) => {
    const list = $('userList');
    if (!list) return;
    list.innerHTML = '';

    users.forEach(u => {
        const row = document.createElement('div');
        row.className = 'user-row';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = `${u.isHost ? '👑 ' : ''}${safeName(u.name)}`;

        const actions = document.createElement('div');
        actions.className = 'user-actions';

        if (isHost && !u.isHost) {
            const callBtn = document.createElement('button');
            callBtn.textContent = 'Call';
            callBtn.onclick = () => startCall(u.id);
            actions.appendChild(callBtn);

            const kickBtn = document.createElement('button');
            kickBtn.textContent = 'Kick';
            kickBtn.onclick = () => socket.emit('kick-user', u.id);
            actions.appendChild(kickBtn);
        }

        row.appendChild(nameSpan);
        row.appendChild(actions);
        list.appendChild(row);
    });
});

socket.on('kicked', () => {
    alert('You were removed from the room by the host.');
    window.location.reload();
});


// ======================================================
// 9. CHAT
// ======================================================

function appendChat({ from, text, ts }) {
    const log = $('chatLog');
    if (!log) return;

    const div = document.createElement('div');
    div.className = 'chat-line';

    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = `[${formatTime(ts)}]`;

    const user = document.createElement('span');
    user.className = 'chat-user';
    user.textContent = `${safeName(from)}:`;

    const msg = document.createElement('span');
    msg.className = 'chat-text';
    msg.textContent = text;

    div.appendChild(time);
    div.appendChild(user);
    div.appendChild(msg);

    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

const chatSendBtn = $('chatSendBtn');
const chatInput = $('chatInput');

if (chatSendBtn && chatInput) {
    chatSendBtn.addEventListener('click', () => {
        const text = chatInput.value.trim();
        if (!text || !currentRoom) return;

        socket.emit('public-chat', {
            room: currentRoom,
            text,
            name: userName
        });
        chatInput.value = '';
    });

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            chatSendBtn.click();
        }
    });
}

socket.on('public-chat', ({ name, text, ts }) => {
    appendChat({ from: name, text, ts });
});


// ======================================================
// 10. EMOJI STRIP
// ======================================================

if ($('emojiStrip')) {
    $('emojiStrip').addEventListener('click', (e) => {
        if (e.target.classList.contains('emoji')) {
            chatInput.value += e.target.textContent;
            chatInput.focus();
        }
    });
}


// ======================================================
// 11. ARCADE UI (HOST SIDE)
// ======================================================

const arcadeInput = $('arcadeInput');
const arcadeSendBtn = $('arcadeSendBtn');
const arcadeStatus = $('arcadeStatus');

let activeToolboxFile = null;

if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if (!file) {
            activeToolboxFile = null;
            if (arcadeStatus) arcadeStatus.textContent = 'No file selected';
            if (arcadeSendBtn) arcadeSendBtn.disabled = true;
            return;
        }

        activeToolboxFile = file;
        if (arcadeStatus) arcadeStatus.textContent = `Active Tool: ${file.name}`;
        if (arcadeSendBtn) arcadeSendBtn.disabled = false;
    });
}

if (arcadeSendBtn) {
    arcadeSendBtn.addEventListener('click', async () => {
        if (!activeToolboxFile) {
            alert('Pick a tool file first.');
            return;
        }
        if (!isStreaming || !pc) {
            alert('You must be streaming to send tools via Arcade.');
            return;
        }

        logStatus(`Sending ${activeToolboxFile.name} via Arcade...`);

        await pushFileToPeer(pc, activeToolboxFile, (percent) => {
            if (arcadeStatus) arcadeStatus.textContent = `Sending: ${percent}%`;
        });

        if (arcadeStatus) arcadeStatus.textContent = `Sent: ${activeToolboxFile.name}`;
    });
}


// ======================================================
// 12. STREAM CONTROLS
// ======================================================

const startStreamBtn = $('startStreamBtn');
const stopStreamBtn = $('stopStreamBtn');

if (startStreamBtn) startStreamBtn.addEventListener('click', startStream);
if (stopStreamBtn) stopStreamBtn.addEventListener('click', stopStream);


// ======================================================
// 13. FILE SHARING TAB (Document sharing)
// ======================================================

const fileInput = $('fileInput');
if (fileInput) {
    fileInput.addEventListener('change', () => { 
        if (fileInput.files.length) { 
            $('fileNameLabel').textContent = fileInput.files[0].name; 
            $('sendFileBtn').disabled = false; 
        } 
    });
}

const sendFileBtn = $('sendFileBtn');
if (sendFileBtn && fileInput) {
    sendFileBtn.addEventListener('click', () => {
        const file = fileInput.files[0];

        // Raised limit – allow larger files through Socket chat (~20MB)
        const MAX_CHAT_FILE = 20 * 1024 * 1024;
        if (file && file.size > MAX_CHAT_FILE) {
            alert("File too large for chat share (limit ~20MB). Use 'Arcade' for massive P2P transfers.");
            return;
        }

        if (!file || !currentRoom) return;

        const reader = new FileReader();
        reader.onload = () => {
            socket.emit('file-share', { 
                room: currentRoom, 
                name: userName, 
                fileName: file.name, 
                fileData: reader.result 
            });
            
            fileInput.value = ''; 
            $('fileNameLabel').textContent = 'No file selected'; 
            $('sendFileBtn').disabled = true;
        };
        reader.readAsDataURL(file);
    });
}

// FIX: SECURE RENDERING (No InnerHTML) – host-side FILES tab log
socket.on('file-share', d => {
    const container = $('fileLog');
    if (!container) return;

    const div = document.createElement('div'); 
    div.className = 'file-item';
    
    const info = document.createElement('div');
    const b = document.createElement('strong'); 
    b.textContent = d.name;
    info.appendChild(b);
    info.appendChild(document.createTextNode(` shared: ${d.fileName}`));
    
    const link = document.createElement('a');
    link.href = d.fileData;
    link.download = d.fileName;
    link.className = 'btn small primary';
    link.textContent = 'Download';
    
    div.appendChild(info);
    div.appendChild(link);
    
    container.appendChild(div);
    if (!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ======================================================
// 14. TOOLBOX OVERLAY
// ======================================================

const toolboxBtn = $('toolboxBtn');
const toolboxPanel = $('toolboxPanel');
const closeToolbox = $('closeToolbox');

if (toolboxBtn && toolboxPanel) {
    toolboxBtn.addEventListener('click', () => {
        toolboxPanel.classList.toggle('open');
    });
}
if (closeToolbox && toolboxPanel) {
    closeToolbox.addEventListener('click', () => {
        toolboxPanel.classList.remove('open');
    });
}


// ======================================================
// 15. REMOTE VIDEO GRID (CALLS)
// ======================================================

function attachRemoteVideo(id, stream) {
    const grid = $('videoGrid');
    if (!grid) return;

    let d = document.getElementById(`remote-${id}`);
    if (!d) {
        d = document.createElement('div');
        d.id = `remote-${id}`;
        d.className = 'video-tile';

        const v = document.createElement('video');
        v.autoplay = true;
        v.playsInline = true;
        v.muted = false;

        d.appendChild(v);

        const h2 = document.createElement('h2');
        h2.textContent = callPeers[id] ? callPeers[id].name : 'Guest';
        d.appendChild(h2);

        grid.appendChild(d);
    }
    const v = d.querySelector('video');
    if (v.srcObject !== stream) v.srcObject = stream;
}

function removeRemoteVideo(id) { 
    const el = document.getElementById(`remote-${id}`); 
    if (el) el.remove(); 
}


// ======================================================
// 16. INITIALIZE
// ======================================================

window.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initLogin();
    initViewerLink();
});

// Make functions available globally for HTML onclick events
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

const openStreamBtn = $('openStreamBtn');
if (openStreamBtn) {
    openStreamBtn.addEventListener('click', () => { 
        const url = $('streamLinkInput').value; 
        if (url) window.open(url, '_blank'); 
    });
}
