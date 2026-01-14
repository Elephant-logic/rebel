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
        console.log(`[Arcade] Sending: ${file.name}`);
        const metadata = JSON.stringify({
            type: 'meta', name: file.name, size: file.size, mime: file.type
        });
        channel.send(metadata);

        const buffer = await file.arrayBuffer();
        let offset = 0;

        const sendLoop = () => {
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }
            if (channel.readyState !== 'open') return;

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
                console.log('[Arcade] Done Sending:', file.name);
                channel.close();
            }
        };

        sendLoop();
    };

    channel.onerror = (err) => console.error('[Arcade] DataChannel error:', err);
}

// ======================================================
// 2. SOCKET & STATE SETUP
// ======================================================

const socket = io({
    autoConnect: false,
    transports: ["websocket"],
    withCredentials: true
});

const $ = id => document.getElementById(id);

let userName = '';
let currentRoom = null;
let isHost = false;
let myId = null;

// --- STREAMING STATE ---
let pc = null;              
let broadcastStream = null; 
let localStream = null;     
let screenStream = null;    
let isStreaming = false;
let isScreenSharing = false;
let activeInput = 'camera'; // 'camera', 'screen', 'mixed', 'none'

// --- CANVAS MIXER ---
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 
let mixerLayout = 'SOLO'; // 'SOLO', 'GUEST', 'PIP', 'SPLIT'
let activeGuestId = null; // The ID of the guest currently selected for the mixer

// --- CONNECTION STORAGE ---
const viewerPeers = {}; // One-way connections (Broadcast)
const callPeers = {};   // Two-way connections (1:1 Calls)

// --- ICE CONFIGURATION (Servers) ---
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ======================================================
// 3. HELPER FUNCTIONS
// ======================================================

function logStatus(msg) {
    console.log('[STATUS]', msg);
    const el = $('statusBar');
    if (el) el.textContent = msg;
}

function safeName(name) {
    return (name || '').toString().slice(0, 30) || 'Anon';
}

// Format timestamps for chat
function formatTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ======================================================
// 4. INITIAL UI SETUP
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
    $('loginBtn').addEventListener('click', () => {
        const name = $('nameInput').value.trim();
        const room = $('roomInput').value.trim();
        if(!name || !room) {
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
    if (!$('viewerLink')) return;
    $('viewerLink').value = '';
    $('copyViewerLink').addEventListener('click', () => {
        const base = window.location.origin;
        const roomSlug = encodeURIComponent(currentRoom || '');
        const url = `${base}/view?room=${roomSlug}`;
        $('viewerLink').value = url;
        navigator.clipboard.writeText(url).then(() => {
            logStatus('Viewer link copied to clipboard.');
        }).catch(() => {
            logStatus('Unable to copy link.');
        });
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
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({ 
                video: true, 
                audio: true 
            });
        }

        if (!canvasStream) {
            canvasStream = canvas.captureStream(30);
        }

        const mergedStream = new MediaStream();
        canvasStream.getVideoTracks().forEach(t => mergedStream.addTrack(t));

        if (localStream.getAudioTracks().length > 0) {
            mergedStream.addTrack(localStream.getAudioTracks()[0]);
        }

        pc = new RTCPeerConnection(iceConfig);
        broadcastStream = mergedStream;

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

        socket.emit('create-offer', {
            room: currentRoom,
            role: 'host'
        });

        isStreaming = true;
        logStatus('Streaming started.');
        $('streamState').textContent = 'LIVE';
        $('startStreamBtn').disabled = true;
        $('stopStreamBtn').disabled = false;
    } catch (err) {
        console.error('Failed to start stream:', err);
        logStatus('Failed to start stream (check camera/mic permissions).');
    }
}

function stopStream() {
    if (!isStreaming) return;

    if (pc) {
        pc.getSenders().forEach(sender => {
            try { pc.removeTrack(sender); } catch(e) {}
        });
        pc.close();
        pc = null;
    }

    isStreaming = false;
    $('streamState').textContent = 'OFF';
    $('startStreamBtn').disabled = false;
    $('stopStreamBtn').disabled = true;
    logStatus('Stream stopped.');
}

// ======================================================
// 6. MIXER RENDER LOOP
// ======================================================

function drawMixerFrame() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (localStream && localStream.getVideoTracks().length) {
        const videoTrack = localStream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        const w = settings.width || 1280;
        const h = settings.height || 720;
        const aspect = w / h;

        let renderW = canvas.width;
        let renderH = Math.round(renderW / aspect);
        if (renderH > canvas.height) {
            renderH = canvas.height;
            renderW = Math.round(renderH * aspect);
        }

        const x = (canvas.width - renderW) / 2;
        const y = (canvas.height - renderH) / 2;

        // Placeholder: we’re not drawing the track frame here,
        // this would require a <video> element rendering, etc.
        ctx.fillStyle = '#222';
        ctx.fillRect(x, y, renderW, renderH);
    }

    requestAnimationFrame(drawMixerFrame);
}
drawMixerFrame();

// ======================================================
// 7. VIEWER PEER CONNECT (HOST SIDE)
// ======================================================

socket.on('viewer-joined', async ({ viewerId }) => {
    if (!isStreaming || !broadcastStream) return;

    if (viewerPeers[viewerId]) return;

    const viewerPc = new RTCPeerConnection(iceConfig);
    viewerPeers[viewerId] = viewerPc;

    broadcastStream.getTracks().forEach(track => viewerPc.addTrack(track, broadcastStream));

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

socket.on('webrtc-answer', async ({ sdp, from }) => {
    const viewerPc = viewerPeers[from];
    if (!viewerPc) return;

    await viewerPc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate, role, from }) => {
    if (role === 'viewer') {
        const viewerPc = viewerPeers[from];
        if (viewerPc) {
            await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }
});

// ======================================================
// 8. 1:1 CALL SYSTEM
// ======================================================

async function startCall(targetId) {
    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (err) {
            console.error('Camera/mic permission denied:', err);
            return;
        }
    }

    const pcCall = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc: pcCall, stream: null };

    localStream.getTracks().forEach(track => pcCall.addTrack(track, localStream));

    pcCall.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('call-ice-candidate', {
                targetId,
                candidate: event.candidate
            });
        }
    };

    pcCall.ontrack = (event) => {
        let stream = event.streams[0];
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

function attachRemoteVideo(id, stream) {
    const container = $('remoteVideos');
    let video = document.getElementById(`vid-${id}`);
    if (!video) {
        video = document.createElement('video');
        video.id = `vid-${id}`;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = false;
        video.style.width = '100%';
        video.style.maxWidth = '320px';
        video.style.borderRadius = '8px';
        video.style.border = '1px solid rgba(255,255,255,0.2)';
        container.appendChild(video);
    }
    video.srcObject = stream;
}

socket.on('call-offer', async ({ from, sdp }) => {
    const pcCall = new RTCPeerConnection(iceConfig);
    callPeers[from] = { pc: pcCall, stream: null };

    pcCall.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('call-ice-candidate', {
                targetId: from,
                candidate: event.candidate
            });
        }
    };

    pcCall.ontrack = (event) => {
        let stream = event.streams[0];
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
    if (!peer) return;
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

function endPeerCall(targetId) {
    const peer = callPeers[targetId];
    if (!peer) return;
    if (peer.pc) peer.pc.close();
    delete callPeers[targetId];

    const el = document.getElementById(`vid-${targetId}`);
    if (el) el.remove();
}

// ======================================================
// 9. ROOM & USER MANAGEMENT
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
    list.innerHTML = '';

    users.forEach(u => {
        const li = document.createElement('div');
        li.className = 'user-row';

        const crown = u.isHost ? '👑 ' : '';
        li.innerHTML = `
            <span>${crown}${safeName(u.name)}</span>
            <div class="user-actions">
                ${(!u.isHost && isHost) ? `<button onclick="ringUser('${u.id}')">Call</button>` : ''}
                ${(isHost && !u.isHost) ? `<button onclick="kickUser('${u.id}')">Kick</button>` : ''}
            </div>
        `;
        list.appendChild(li);
    });
});

socket.on('kicked', () => {
    alert('You were removed from the room by the host.');
    location.reload();
});

// ======================================================
// 10. CHAT
// ======================================================

function appendChat({ from, text, ts }) {
    const log = $('chatLog');
    const div = document.createElement('div');
    const time = formatTime(ts);

    div.className = 'chat-line';
    div.innerHTML = `
        <span class="chat-time">[${time}]</span>
        <span class="chat-user">${safeName(from)}:</span>
        <span class="chat-text">${text}</span>
    `;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

$('chatSendBtn').addEventListener('click', () => {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text || !currentRoom) return;

    socket.emit('public-chat', {
        room: currentRoom,
        text,
        name: userName
    });
    input.value = '';
});

$('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        $('chatSendBtn').click();
    }
});

socket.on('public-chat', ({ name, text, ts }) => {
    appendChat({ from: name, text, ts });
});

// ======================================================
// 11. ARCADE UI (Host Side)
// ======================================================

const arcadeInput = $('arcadeInput');
let activeToolboxFile = null;

if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if(!file) return;
        
        activeToolboxFile = file;
        $('arcadeStatus').textContent = `Active Tool: ${file.name}`;
        
        // --- ADD FORCE RESEND BUTTON DYNAMICALLY ---
        // This is crucial if a user joins later or the host wants to resend the same file.
        const resendBtn = $('arcadeResendBtn');
        if (resendBtn) {
            resendBtn.disabled = false;
        }
    });
}

const arcadeSendBtn = $('arcadeSendBtn');
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
            $('arcadeStatus').textContent = `Sending: ${percent}%`;
        });

        $('arcadeStatus').textContent = `Sent: ${activeToolboxFile.name}`;
    });
}

const arcadeResendBtn = $('arcadeResendBtn');
if (arcadeResendBtn) {
    arcadeResendBtn.addEventListener('click', async () => {
        if (!activeToolboxFile) {
            alert('No active tool to resend.');
            return;
        }
        if (!isStreaming || !pc) {
            alert('You must be streaming to resend via Arcade.');
            return;
        }

        logStatus(`Re-sending ${activeToolboxFile.name} via Arcade...`);
        
        await pushFileToPeer(pc, activeToolboxFile, (percent) => {
            $('arcadeStatus').textContent = `Re-sending: ${percent}%`;
        });

        $('arcadeStatus').textContent = `Re-sent: ${activeToolboxFile.name}`;
    });
}

// ======================================================
// 12. STREAM CONTROLS
// ======================================================

$('startStreamBtn').addEventListener('click', startStream);
$('stopStreamBtn').addEventListener('click', stopStream);

// ======================================================
// 13. EMOJI STRIP
// ======================================================

if ($('emojiStrip')) {
    $('emojiStrip').addEventListener('click', (e) => { 
        if(e.target.classList.contains('emoji')) { 
            $('chatInput').value += e.target.textContent; 
        }
    });
}


// ======================================================
// 14. FILE SHARING TAB (Document sharing)
// ======================================================

const fileInput = $('fileInput');
fileInput.addEventListener('change', () => { 
    if (fileInput.files.length) { 
        $('fileNameLabel').textContent = fileInput.files[0].name; 
        $('sendFileBtn').disabled = false; 
    } 
});

$('sendFileBtn').addEventListener('click', () => {
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

// FIX: SECURE RENDERING (No InnerHTML)
socket.on('file-share', d => {
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
    
    $('fileLog').appendChild(div);
    if (!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ======================================================
// 15. ARCADE INPUT LOGIC
// ======================================================

const arcadeInput2 = $('arcadeInput2');
if (arcadeInput2) {
    arcadeInput2.addEventListener('change', () => {
        const file = arcadeInput2.files[0];
        if(!file) return;
        
        activeToolboxFile = file;
        $('arcadeStatus2').textContent = `Active Tool: ${file.name}`;
        
        const resendBtn = $('arcadeResendBtn2');
        if (resendBtn) {
            resendBtn.disabled = false;
        }
    });
}

const arcadeSendBtn2 = $('arcadeSendBtn2');
if (arcadeSendBtn2) {
    arcadeSendBtn2.addEventListener('click', async () => {
        if (!activeToolboxFile) {
            alert('Pick a tool file first.');
            return;
        }
        if (!isStreaming || !pc) {
            alert('You must be streaming to send tools via Arcade.');
            return;
        }

        logStatus(`Sending ${activeToolboxFile.name} via Arcade (Slot 2)...`);
        
        await pushFileToPeer(pc, activeToolboxFile, (percent) => {
            $('arcadeStatus2').textContent = `Sending: ${percent}%`;
        });

        $('arcadeStatus2').textContent = `Sent: ${activeToolboxFile.name}`;
    });
}

const arcadeResendBtn2 = $('arcadeResendBtn2');
if (arcadeResendBtn2) {
    arcadeResendBtn2.addEventListener('click', async () => {
        if (!activeToolboxFile) {
            alert('No active tool to resend.');
            return;
        }
        if (!isStreaming || !pc) {
            alert('You must be streaming to resend via Arcade.');
            return;
        }

        logStatus(`Re-sending ${activeToolboxFile.name} via Arcade (Slot 2)...`);
        
        await pushFileToPeer(pc, activeToolboxFile, (percent) => {
            $('arcadeStatus2').textContent = `Re-sending: ${percent}%`;
        });

        $('arcadeStatus2').textContent = `Re-sent: ${activeToolboxFile.name}`;
    });
}

// ======================================================
// 16. TOOLBOX OVERLAY
// ======================================================

const toolboxBtn = $('toolboxBtn');
const toolboxPanel = $('toolboxPanel');
const closeToolbox = $('closeToolbox');

if (toolboxBtn && toolboxPanel) {
    toolboxBtn.addEventListener('click', () => {
        toolboxPanel.classList.toggle('open');
    });
}
if (closeToolbox) {
    closeToolbox.addEventListener('click', () => {
        toolboxPanel.classList.remove('open');
    });
}

// ======================================================
// 17. INITIALIZE
// ======================================================

window.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initLogin();
    initViewerLink();
});

function removeRemoteVideo(id) { 
    const el = document.getElementById(`vid-${id}`); 
    if(el) el.remove(); 
}

// Make functions available globally for HTML onclick events
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

if ($('openStreamBtn')) {
    $('openStreamBtn').addEventListener('click', () => { 
        const url = $('streamLinkInput').value; 
        if(url) window.open(url, '_blank'); 
    });
}
