// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
const CHUNK_SIZE = 16 * 1024; // 16KB chunks (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit to prevent crashes

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;

    // Create a specific data channel for the arcade
    const channel = pc.createDataChannel("side-load-pipe");

    channel.onopen = async () => {
        console.log(`[Arcade] Starting transfer of: ${file.name}`);

        // 1. Send Metadata
        const metadata = JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            mime: file.type
        });
        channel.send(metadata);

        // 2. Read the file into memory
        const buffer = await file.arrayBuffer();
        let offset = 0;

        // 3. Send Loop (Chunks)
        const sendLoop = () => {
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }
            if (channel.readyState !== 'open') {
                return;
            }

            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;

            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            if (offset < buffer.byteLength) {
                setTimeout(sendLoop, 0); 
            } else {
                console.log(`[Arcade] Transfer Complete.`);
                setTimeout(() => { channel.close(); }, 1000);
            }
        };
        sendLoop();
    };
}


// ======================================================
// 2. MAIN APP SETUP & VARIABLES
// ======================================================

console.log("Rebel Stream Host App Loaded"); 

const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

// --- GLOBAL VARIABLES ---
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let latestUserList = [];
let currentOwnerId = null;

// --- VIP BOUNCER STATE ---
let isPrivateMode = false;
let allowedGuests = [];

// --- MEDIA STATE ---
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false; 

// --- ARCADE STATE ---
let activeToolboxFile = null;

// --- MIXER STATE (Patched) ---
let audioContext = null;
let audioDestination = null;
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 
let mixerLayout = 'SOLO'; // 'SOLO', 'GUEST', 'PIP', 'SPLIT'
let activeGuestId = null; 

// --- CONNECTION STORAGE ---
const viewerPeers = {}; 
const callPeers = {};   

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ======================================================
// 3. CANVAS MIXER ENGINE (UPDATED FOR BETTER SPLIT)
// ======================================================

function drawMixer() {
    if (!ctx) return;
    
    // 1. Paint Background (Black)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Get Source Elements
    const myVideo = $('localVideo');
    let guestVideo = null;
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`);
        if(el) guestVideo = el.querySelector('video');
    }

    // 3. Draw based on Layout Mode
    if (mixerLayout === 'SOLO') {
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
    } 
    else if (mixerLayout === 'GUEST') {
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = '#333'; ctx.fillRect(0,0,canvas.width, canvas.height);
            ctx.fillStyle = '#fff'; ctx.font = "60px Arial"; ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest...", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        // --- PATCHED SPLIT LOGIC (Preserve 16:9 Aspect Ratio) ---
        // Canvas is 1920x1080. Half width is 960.
        // A 16:9 video that is 960px wide should be 540px tall.
        // We will center it vertically.
        
        const slotW = 960;
        const vidH = 540; // 960 / (16/9)
        const yOffset = (1080 - vidH) / 2; // (1080 - 540) / 2 = 270px down

        // Draw Host (Left)
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, yOffset, slotW, vidH);
        }
        
        // Draw Guest (Right)
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 960, yOffset, slotW, vidH);
        }
        
        // Draw Divider Line
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(960, 0);
        ctx.lineTo(960, 1080);
        ctx.stroke();
    }
    else if (mixerLayout === 'PIP') {
        // Host Full
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
        // Guest Small Overlay
        if (guestVideo && guestVideo.readyState === 4) {
            const pipW = 480;
            const pipH = 270;
            const padding = 30;
            const x = canvas.width - pipW - padding;
            const y = canvas.height - pipH - padding;
            
            ctx.strokeStyle = "#4af3a3";
            ctx.lineWidth = 5;
            ctx.strokeRect(x, y, pipW, pipH);
            ctx.drawImage(guestVideo, x, y, pipW, pipH);
        }
    }

    requestAnimationFrame(drawMixer);
}

// Start the Mixer
canvasStream = canvas.captureStream(30);
drawMixer();

// --- MIXER CONTROLS ---
window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    // Update UI Buttons
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active');
        if (b.textContent.toUpperCase().includes(mode) || (mode==='PIP' && b.textContent.includes('Overlay'))) {
            b.classList.add('active');
        }
    });
};

window.setActiveGuest = (id) => {
    activeGuestId = id;
    alert(`Guest Selected! Switch to 'Overlay' or 'Split' to view.`);
};


// ======================================================
// 4. TAB NAVIGATION INTERFACE
// ======================================================

const tabs = { 
    stream: $('tabStreamChat'), 
    room: $('tabRoomChat'), 
    files: $('tabFiles'), 
    users: $('tabUsers') 
};

const contents = { 
    stream: $('contentStreamChat'), 
    room: $('contentRoomChat'), 
    files: $('contentFiles'), 
    users: $('contentUsers') 
};

function switchTab(name) {
    if (!tabs[name]) return;
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));
    tabs[name].classList.add('active');
    contents[name].classList.add('active');
    tabs[name].classList.remove('has-new');
}
Object.keys(tabs).forEach(k => { if(tabs[k]) tabs[k].onclick = () => switchTab(k); });


// ======================================================
// 5. DEVICE SETTINGS (Audio/Video/Mixer)
// ======================================================

const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); 
const videoSource = $('videoSource');
const videoQuality = $('videoQuality');

if ($('settingsBtn')) {
    $('settingsBtn').addEventListener('click', () => {
        const isHidden = settingsPanel.style.display === 'none' || settingsPanel.style.display === '';
        settingsPanel.style.display = isHidden ? 'block' : 'none';
        if (isHidden) getDevices();
    });
}
if ($('closeSettingsBtn')) $('closeSettingsBtn').onclick = () => settingsPanel.style.display = 'none';

async function getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        audioSource.innerHTML = ''; 
        videoSource.innerHTML = '';
        if(audioSource2) audioSource2.innerHTML = '<option value="">-- None --</option>';

        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
                if(audioSource2) audioSource2.appendChild(opt.cloneNode(true));
            }
            if (d.kind === 'videoinput') {
                videoSource.appendChild(opt);
            }
        });
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at) audioSource.value = at.getSettings().deviceId;
            if (vt) videoSource.value = vt.getSettings().deviceId;
        }
    } catch (e) { console.error(e); }
}

audioSource.onchange = startLocalMedia;
if(audioSource2) audioSource2.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;
if(videoQuality) videoQuality.onchange = startLocalMedia;


// ======================================================
// 6. MEDIA CONTROLS (CAMERA, MIC & MIXER ENGINE)
// ======================================================

async function startLocalMedia() {
    if (isScreenSharing) return;

    if (localStream) localStream.getTracks().forEach(t => t.stop());

    try {
        const quality = videoQuality ? videoQuality.value : 'ideal';
        let widthConstraint, heightConstraint;

        if (quality === 'max') {
             widthConstraint = { ideal: 1920 }; heightConstraint = { ideal: 1080 };
        } else if (quality === 'low') {
             widthConstraint = { ideal: 640 }; heightConstraint = { ideal: 360 };
        } else {
             widthConstraint = { ideal: 1280 }; heightConstraint = { ideal: 720 };
        }

        const constraints = {
            audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
            video: { 
                deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
                width: widthConstraint,
                height: heightConstraint
            }
        };

        const mainStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // AUDIO MIXER
        let finalAudioTrack = mainStream.getAudioTracks()[0];
        const secondaryId = audioSource2 ? audioSource2.value : null;

        if (secondaryId) {
            const secStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: secondaryId } } });
            if(!audioContext) audioContext = new AudioContext();
            audioDestination = audioContext.createMediaStreamDestination();
            const src1 = audioContext.createMediaStreamSource(mainStream);
            const src2 = audioContext.createMediaStreamSource(secStream);
            src1.connect(audioDestination);
            src2.connect(audioDestination);
            finalAudioTrack = audioDestination.stream.getAudioTracks()[0];
        }

        localStream = new MediaStream([mainStream.getVideoTracks()[0], finalAudioTrack]);
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true;

        // UPDATE VIEWERS WITH MIXER OUTPUT
        const mixedVideoTrack = canvasStream.getVideoTracks()[0];
        const updateViewerPC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            const vSender = senders.find(s => s.track && s.track.kind === 'video');
            if (vSender) vSender.replaceTrack(mixedVideoTrack); // SEND CANVAS
            const aSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (aSender) aSender.replaceTrack(finalAudioTrack); // SEND MIX AUDIO
        };
        Object.values(viewerPeers).forEach(updateViewerPC);
        
        // UPDATE GUESTS (KEEP RAW CAM)
        Object.values(callPeers).forEach(p => {
             const senders = p.pc.getSenders();
             const vSender = senders.find(s => s.track && s.track.kind === 'video');
             if(vSender) vSender.replaceTrack(mainStream.getVideoTracks()[0]);
             const aSender = senders.find(s => s.track && s.track.kind === 'audio');
             if(aSender) aSender.replaceTrack(finalAudioTrack);
        });

        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { 
        console.error(e); 
        alert("Camera access failed. Please check permissions."); 
    }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];
    if ($('toggleCamBtn')) {
        const isCamOn = vTrack && vTrack.enabled;
        $('toggleCamBtn').textContent = isCamOn ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !isCamOn);
    }
    if ($('toggleMicBtn')) {
        const isMicOn = aTrack && aTrack.enabled;
        $('toggleMicBtn').textContent = isMicOn ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !isMicOn);
    }
}

if ($('toggleMicBtn')) $('toggleMicBtn').addEventListener('click', () => { if (localStream) { const t = localStream.getAudioTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } });
if ($('toggleCamBtn')) $('toggleCamBtn').addEventListener('click', () => { if (localStream) { const t = localStream.getVideoTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } });


// ======================================================
// 7. SCREEN SHARING LOGIC
// ======================================================

if ($('shareScreenBtn')) {
    $('shareScreenBtn').addEventListener('click', async () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                isScreenSharing = true;
                $('shareScreenBtn').textContent = 'Stop Screen';
                $('shareScreenBtn').classList.add('danger');
                $('localVideo').srcObject = screenStream; // Mixer picks this up
                screenStream.getVideoTracks()[0].onended = stopScreenShare;
            } catch(e) { console.error("Screen share cancelled", e); }
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    isScreenSharing = false;
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    startLocalMedia();
}


// ======================================================
// 8. BROADCAST STREAMING (1-to-Many)
// ======================================================

if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) return alert("Host only functionality.");
        
        if (isStreaming) {
            isStreaming = false;
            $('startStreamBtn').textContent = "Start Stream";
            $('startStreamBtn').classList.remove('danger');
            Object.values(viewerPeers).forEach(pc => pc.close());
            for (const k in viewerPeers) delete viewerPeers[k];
        } else {
            if (!localStream) await startLocalMedia();
            isStreaming = true;
            $('startStreamBtn').textContent = "Stop Stream"; 
            $('startStreamBtn').classList.add('danger');
            latestUserList.forEach(u => { if (u.id !== myId) connectViewer(u.id); });
        }
    });
}


// ======================================================
// 9. P2P CALLING (1-to-1)
// ======================================================

if ($('hangupBtn')) $('hangupBtn').addEventListener('click', () => { Object.keys(callPeers).forEach(id => endPeerCall(id)); });
socket.on('ring-alert', async ({ from, fromId }) => { if (confirm(`Call from ${from}?`)) await callPeer(fromId); });

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

socket.on('call-answer', async ({ from, answer }) => { if (callPeers[from]) await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer)); });
socket.on('call-ice', ({ from, candidate }) => { if (callPeers[from]) callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)); });
socket.on('call-end', ({ from }) => { endPeerCall(from, true); });

function endPeerCall(id, isIncomingSignal) {
    if (callPeers[id]) { try { callPeers[id].pc.close(); } catch(e){} }
    delete callPeers[id];
    removeRemoteVideo(id);
    if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
    renderUserList();
}


// ======================================================
// 10. WEBRTC SIGNALING (BROADCAST)
// ======================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); };
    
    // SEND CANVAS MIXER STREAM TO VIEWER
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    if(localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if(audioTrack) pc.addTrack(audioTrack, canvasStream);
    }
    
    // AUTO PUSH ARCADE
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing tool to ${targetId}`);
        pushFileToPeer(pc, activeToolboxFile, null); 
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => { if (viewerPeers[from]) await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp)); });
socket.on('webrtc-ice-candidate', async ({ from, candidate }) => { if (viewerPeers[from]) await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate)); });


// ======================================================
// 11. SOCKET & ROOM LOGIC
// ======================================================

socket.on('connect', () => { $('signalStatus').className = 'status-dot status-connected'; $('signalStatus').textContent = 'Connected'; myId = socket.id; });
socket.on('disconnect', () => { $('signalStatus').className = 'status-dot status-disconnected'; $('signalStatus').textContent = 'Disconnected'; });

$('joinBtn').addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    if (!room) return;
    currentRoom = room; 
    userName = $('nameInput').value.trim() || 'Host';
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    $('joinBtn').disabled = true; $('leaveBtn').disabled = false;
    updateLink(room);
    startLocalMedia();
});

if ($('leaveBtn')) $('leaveBtn').addEventListener('click', () => { window.location.reload(); });

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}

socket.on('user-joined', ({ id, name }) => {
    if (iAmHost && isPrivateMode && !allowedGuests.some(g => g.toLowerCase() === name.toLowerCase())) {
        socket.emit('kick-user', id);
        return; 
    }
    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
});

socket.on('user-left', ({ id }) => {
    if (viewerPeers[id]) { viewerPeers[id].close(); delete viewerPeers[id]; }
    endPeerCall(id, true);
});

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users;
    currentOwnerId = ownerId;
    if (streamTitle && $('streamTitleInput')) $('streamTitleInput').value = streamTitle;
    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? 'Unlock Room' : 'Lock Room';
        $('lockRoomBtn').onclick = () => { if(iAmHost) socket.emit('lock-room', !locked); };
    }
    renderUserList();
});

socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    if ($('localContainer')) $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});


// ======================================================
// 12. CONTROLS (Chat, Files, Arcade, Users)
// ======================================================

if ($('updateTitleBtn')) $('updateTitleBtn').onclick = () => socket.emit('update-stream-title', $('streamTitleInput').value.trim());
if ($('updateSlugBtn')) $('updateSlugBtn').onclick = () => updateLink($('slugInput').value.trim());
if ($('togglePrivateBtn')) $('togglePrivateBtn').onclick = () => {
    isPrivateMode = !isPrivateMode;
    $('togglePrivateBtn').textContent = isPrivateMode ? "ON" : "OFF";
    $('togglePrivateBtn').className = isPrivateMode ? "btn small danger" : "btn small secondary";
    $('guestListPanel').style.display = isPrivateMode ? "block" : "none";
    if (isPrivateMode) latestUserList.forEach(u => { if(u.id !== myId && !allowedGuests.some(g=>g.toLowerCase() === u.name.toLowerCase())) socket.emit('kick-user', u.id); });
};
if ($('addGuestBtn')) $('addGuestBtn').onclick = () => { const name = $('guestNameInput').value.trim(); if(name && !allowedGuests.includes(name)) { allowedGuests.push(name); renderGuestList(); $('guestNameInput').value=''; } };
function renderGuestList() { $('guestListDisplay').innerHTML = ''; allowedGuests.forEach(name => { const tag = document.createElement('span'); tag.style.cssText = "background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem;"; tag.textContent = name; $('guestListDisplay').appendChild(tag); }); }

function appendChat(log, name, text, ts) {
    const d = document.createElement('div'); d.className = 'chat-line';
    const s = document.createElement('strong'); s.textContent = name;
    const t = document.createElement('small'); t.textContent = new Date(ts).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    d.append(s, document.createTextNode(' '), t, txt);
    log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function sendPublic() { const inp = $('inputPublic'); const text = inp.value.trim(); if(!text || !currentRoom) return; socket.emit('public-chat', { room: currentRoom, name: userName, text }); inp.value = ''; }
$('btnSendPublic').onclick = sendPublic; $('inputPublic').onkeydown = e => { if(e.key==='Enter') sendPublic(); };
function sendPrivate() { const inp = $('inputPrivate'); const text = inp.value.trim(); if(!text || !currentRoom) return; socket.emit('private-chat', { room: currentRoom, name: userName, text }); inp.value = ''; }
$('btnSendPrivate').onclick = sendPrivate; $('inputPrivate').onkeydown = e => { if(e.key==='Enter') sendPrivate(); };
socket.on('public-chat', d => { appendChat($('chatLogPublic'), d.name, d.text, d.ts); if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); });
socket.on('private-chat', d => { appendChat($('chatLogPrivate'), d.name, d.text, d.ts); if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); });

if ($('emojiStripPublic')) $('emojiStripPublic').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; };
if ($('emojiStripPrivate')) $('emojiStripPrivate').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; };

$('fileInput').onchange = () => { if($('fileInput').files.length) { $('fileNameLabel').textContent = $('fileInput').files[0].name; $('sendFileBtn').disabled = false; } };
$('sendFileBtn').onclick = () => {
    const file = $('fileInput').files[0];
    if(file.size > 1024 * 1024) return alert("File too large (1MB Limit). Use 'Arcade'.");
    const reader = new FileReader();
    reader.onload = () => { socket.emit('file-share', { room: currentRoom, name: userName, fileName: file.name, fileData: reader.result }); $('sendFileBtn').disabled = true; $('fileNameLabel').textContent = 'Sent'; };
    reader.readAsDataURL(file);
};
socket.on('file-share', d => {
    const div = document.createElement('div'); div.className = 'file-item';
    const b = document.createElement('strong'); b.textContent = d.name;
    const link = document.createElement('a'); link.href = d.fileData; link.download = d.fileName; link.className = 'btn small primary'; link.textContent = 'Download';
    const info = document.createElement('div'); info.append(b, document.createTextNode(` shared: ${d.fileName}`));
    div.append(info, link); $('fileLog').appendChild(div);
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});

const arcadeInput = $('arcadeInput');
if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0]; if(!file) return;
        activeToolboxFile = file; $('arcadeStatus').textContent = `Active Tool: ${file.name}`;
        Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
    });
}

function renderUserList() {
    const list = $('userList'); list.innerHTML = '';
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        const div = document.createElement('div'); div.className = 'user-item';
        const nameSpan = document.createElement('span'); if (u.id === currentOwnerId) nameSpan.textContent = '👑 '; nameSpan.textContent += u.name;
        const actionsDiv = document.createElement('div'); actionsDiv.className = 'user-actions';
        const isCalling = !!callPeers[u.id];
        const actionBtn = document.createElement('button'); actionBtn.className = 'action-btn';
        if (isCalling) {
            actionBtn.textContent = 'End Call'; actionBtn.style.cssText = 'border-color:var(--danger); color:var(--danger)';
            actionBtn.onclick = () => endPeerCall(u.id);
        } else {
            actionBtn.textContent = 'Call'; actionBtn.onclick = () => window.ringUser(u.id);
        }
        actionsDiv.appendChild(actionBtn);

        // MIXER SELECTOR
        if (isCalling && iAmHost) {
            const selBtn = document.createElement('button'); selBtn.className = 'action-btn';
            selBtn.textContent = (activeGuestId === u.id) ? 'Selected' : 'Select';
            selBtn.onclick = () => { activeGuestId = u.id; renderUserList(); window.setActiveGuest(u.id); };
            actionsDiv.appendChild(selBtn);
        }

        if (iAmHost) {
            const kickBtn = document.createElement('button'); kickBtn.className = 'action-btn kick';
            kickBtn.textContent = 'Kick'; kickBtn.onclick = () => window.kickUser(u.id);
            actionsDiv.appendChild(kickBtn);
        }
        div.append(nameSpan, actionsDiv); list.appendChild(div);
    });
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`;
        const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; d.appendChild(v);
        const h2 = document.createElement('h2'); h2.textContent = callPeers[id] ? callPeers[id].name : 'Guest'; d.appendChild(h2);
        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); if(v.srcObject !== stream) v.srcObject = stream;
}
function removeRemoteVideo(id) { const el = document.getElementById(`vid-${id}`); if(el) el.remove(); }
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);
if ($('openStreamBtn')) $('openStreamBtn').onclick = () => { const url = $('streamLinkInput').value; if(url) window.open(url, '_blank'); };
