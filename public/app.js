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
    const channel = pc.createDataChannel("side-load-pipe");

    channel.onopen = async () => {
        console.log(`[Arcade] Starting transfer of: ${file.name}`);

        // 1. Send Metadata
        channel.send(JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            mime: file.type
        }));

        // 2. Read file
        const buffer = await file.arrayBuffer();
        let offset = 0;

        // 3. Send Loop
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

            if (offset < buffer.byteLength) {
                setTimeout(sendLoop, 0);
            } else {
                console.log(`[Arcade] Transfer Complete.`);
                setTimeout(() => channel.close(), 1000);
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
let isPrivateMode = false;
let allowedGuests = [];

// --- MEDIA STATE ---
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false; 
let activeToolboxFile = null;

// --- MIXER STATE (Canvas Engine) ---
let audioContext = null;
let audioDestination = null;
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 
let mixerLayout = 'SOLO'; // SOLO, GUEST, SPLIT, PIP
let activeGuestId = null; 

// --- CONNECTIONS ---
const viewerPeers = {}; 
const callPeers = {};   

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ======================================================
// 3. CANVAS MIXER ENGINE (The Broadcast Logic)
// ======================================================

function drawMixer() {
    if (!ctx) return;
    
    // 1. Background (Black)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Get Sources
    const myVideo = $('localVideo'); // Always exists (You/Screen)
    let guestVideo = null;
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`);
        if(el) guestVideo = el.querySelector('video');
    }

    // 3. Draw Layouts
    if (mixerLayout === 'SOLO') {
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
    } 
    else if (mixerLayout === 'GUEST') {
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = '#222'; ctx.fillRect(0,0,canvas.width, canvas.height);
            ctx.fillStyle = '#fff'; ctx.font = "60px Arial"; ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest Signal...", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        // Professional Center Split (Letterboxed)
        const targetW = 960; // 1920 / 2
        const targetH = 540; // 960 / (16/9) aspect ratio
        const yOffset = (1080 - targetH) / 2; // Vertical Center
        
        // Host (Left)
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, yOffset, targetW, targetH);
        }
        // Guest (Right)
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 960, yOffset, targetW, targetH);
        }
        
        // Divider
        ctx.strokeStyle = "#333"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(960, 0); ctx.lineTo(960, 1080); ctx.stroke();
    }
    else if (mixerLayout === 'PIP') {
        // Background: Host
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
        // Overlay: Guest (Bottom Right)
        if (guestVideo && guestVideo.readyState === 4) {
            const w = 480, h = 270, pad = 30;
            const x = canvas.width - w - pad;
            const y = canvas.height - h - pad;
            ctx.strokeStyle = "#4af3a3"; ctx.lineWidth = 4;
            ctx.strokeRect(x, y, w, h);
            ctx.drawImage(guestVideo, x, y, w, h);
        }
    }

    requestAnimationFrame(drawMixer);
}

// Start Engine
canvasStream = canvas.captureStream(30); // 30 FPS
drawMixer();

// Exposed Controls
window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active');
        if(b.textContent.toUpperCase().includes(mode) || (mode==='PIP' && b.textContent.includes('Overlay'))) {
            b.classList.add('active');
        }
    });
};

window.setActiveGuest = (id) => {
    activeGuestId = id;
    alert(`Guest Selected. Switch to 'Split' or 'Overlay' to view.`);
};


// ======================================================
// 4. TAB NAVIGATION
// ======================================================
const tabs = { stream: $('tabStreamChat'), room: $('tabRoomChat'), files: $('tabFiles'), users: $('tabUsers') };
const contents = { stream: $('contentStreamChat'), room: $('contentRoomChat'), files: $('contentFiles'), users: $('contentUsers') };

function switchTab(name) {
    if (!tabs[name]) return;
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));
    tabs[name].classList.add('active'); contents[name].classList.add('active');
    tabs[name].classList.remove('has-new');
}
Object.keys(tabs).forEach(k => { if(tabs[k]) tabs[k].onclick = () => switchTab(k); });


// ======================================================
// 5. DEVICE SETTINGS (Audio/Video/Mixer)
// ======================================================
const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); // Mixer Input
const videoSource = $('videoSource');
const videoQuality = $('videoQuality');

if ($('settingsBtn')) $('settingsBtn').onclick = () => {
    const isHidden = settingsPanel.style.display === 'none' || settingsPanel.style.display === '';
    settingsPanel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) getDevices();
};
if ($('closeSettingsBtn')) $('closeSettingsBtn').onclick = () => settingsPanel.style.display = 'none';

async function getDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        audioSource.innerHTML = ''; audioSource2.innerHTML = '<option value="">-- None --</option>'; videoSource.innerHTML = '';
        
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
                audioSource2.appendChild(opt.cloneNode(true));
            }
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
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
audioSource2.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;
videoQuality.onchange = startLocalMedia;


// ======================================================
// 6. MEDIA LOGIC
// ======================================================
async function startLocalMedia() {
    if (isScreenSharing) return;

    if (localStream) localStream.getTracks().forEach(t => t.stop());

    // Resolution Constraints
    const quality = videoQuality ? videoQuality.value : 'ideal';
    let widthConstraint, heightConstraint;
    if (quality === 'max') { widthConstraint = { ideal: 1920 }; heightConstraint = { ideal: 1080 }; } 
    else if (quality === 'low') { widthConstraint = { ideal: 640 }; heightConstraint = { ideal: 360 }; } 
    else { widthConstraint = { ideal: 1280 }; heightConstraint = { ideal: 720 }; }

    try {
        // Get Main Cam
        const mainStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
            video: { 
                deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
                width: widthConstraint, height: heightConstraint
            }
        });

        // Audio Mixing
        let finalAudioTrack = mainStream.getAudioTracks()[0];
        const secondaryId = audioSource2 ? audioSource2.value : null;

        if (secondaryId) {
            const secStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: secondaryId } } });
            
            if(!audioContext) audioContext = new AudioContext();
            if(audioContext.state === 'suspended') audioContext.resume();
            
            audioDestination = audioContext.createMediaStreamDestination();
            const src1 = audioContext.createMediaStreamSource(mainStream);
            const src2 = audioContext.createMediaStreamSource(secStream);
            src1.connect(audioDestination);
            src2.connect(audioDestination);
            finalAudioTrack = audioDestination.stream.getAudioTracks()[0];
        }

        // Set Local Stream (For Preview)
        localStream = new MediaStream([mainStream.getVideoTracks()[0], finalAudioTrack]);
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; // Mute preview

        // Update Viewers with MIXED Canvas + Mixed Audio
        const mixedVideoTrack = canvasStream.getVideoTracks()[0];
        const updateViewerPC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            const vSender = senders.find(s => s.track && s.track.kind === 'video');
            if (vSender) vSender.replaceTrack(mixedVideoTrack);
            const aSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (aSender) aSender.replaceTrack(finalAudioTrack);
        };
        Object.values(viewerPeers).forEach(updateViewerPC);

        // Update Guests (Send Raw Cam)
        Object.values(callPeers).forEach(p => {
             const senders = p.pc.getSenders();
             const vSender = senders.find(s => s.track && s.track.kind === 'video');
             if(vSender) vSender.replaceTrack(mainStream.getVideoTracks()[0]);
             const aSender = senders.find(s => s.track && s.track.kind === 'audio');
             if(aSender) aSender.replaceTrack(finalAudioTrack);
        });

        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { console.error(e); alert("Camera Error. Check permissions."); }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];
    if ($('toggleCamBtn')) {
        const on = vTrack && vTrack.enabled;
        $('toggleCamBtn').textContent = on ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !on);
    }
    if ($('toggleMicBtn')) {
        const on = aTrack && aTrack.enabled;
        $('toggleMicBtn').textContent = on ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !on);
    }
}
if ($('toggleMicBtn')) $('toggleMicBtn').onclick = () => { if(localStream) { const t = localStream.getAudioTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } };
if ($('toggleCamBtn')) $('toggleCamBtn').onclick = () => { if(localStream) { const t = localStream.getVideoTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } };


// ======================================================
// 7. SCREEN SHARING
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
                $('localVideo').srcObject = screenStream; // Mixer picks this up automatically
                screenStream.getVideoTracks()[0].onended = stopScreenShare;
            } catch(e) { console.error("Screen share cancelled", e); }
        }
    });
}
function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = null; isScreenSharing = false;
    $('shareScreenBtn').textContent = 'Share Screen'; $('shareScreenBtn').classList.remove('danger');
    startLocalMedia();
}


// ======================================================
// 8. BROADCAST & CALLING
// ======================================================
if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) return alert("Host only.");
        if (isStreaming) {
            isStreaming = false;
            $('startStreamBtn').textContent = "Start Stream"; $('startStreamBtn').classList.remove('danger');
            Object.values(viewerPeers).forEach(pc => pc.close());
            for (const k in viewerPeers) delete viewerPeers[k];
        } else {
            if (!localStream) await startLocalMedia();
            isStreaming = true;
            $('startStreamBtn').textContent = "Stop Stream"; $('startStreamBtn').classList.add('danger');
            latestUserList.forEach(u => { if (u.id !== myId) connectViewer(u.id); });
        }
    });
}
if ($('hangupBtn')) $('hangupBtn').onclick = () => Object.keys(callPeers).forEach(id => endPeerCall(id));

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
socket.on('call-end', ({ from }) => endPeerCall(from, true));

function endPeerCall(id, isIncomingSignal) {
    if (callPeers[id]) { try { callPeers[id].pc.close(); } catch(e){} }
    delete callPeers[id];
    removeRemoteVideo(id);
    if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
    renderUserList();
}

// ======================================================
// 9. SIGNALING
// ======================================================
async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); };
    
    // Send MIXED stream
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    if(localStream) {
        const at = localStream.getAudioTracks()[0];
        if(at) pc.addTrack(at, canvasStream);
    }
    
    // Auto-push Arcade
    if (activeToolboxFile) pushFileToPeer(pc, activeToolboxFile, null);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => { if (viewerPeers[from]) await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp)); });
socket.on('webrtc-ice-candidate', async ({ from, candidate }) => { if (viewerPeers[from]) await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate)); });

// ======================================================
// 10. SOCKET & ROOM LOGIC
// ======================================================
socket.on('connect', () => { $('signalStatus').className = 'status-dot status-connected'; $('signalStatus').textContent = 'Connected'; myId = socket.id; });
socket.on('disconnect', () => { $('signalStatus').className = 'status-dot status-disconnected'; $('signalStatus').textContent = 'Disconnected'; });
$('joinBtn').onclick = () => {
    const room = $('roomInput').value.trim();
    if (!room) return;
    currentRoom = room; userName = $('nameInput').value.trim() || 'Host';
    socket.connect(); socket.emit('join-room', { room, name: userName });
    $('joinBtn').disabled = true; $('leaveBtn').disabled = false;
    updateLink(room); startLocalMedia();
};
if ($('leaveBtn')) $('leaveBtn').onclick = () => window.location.reload();
function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}

socket.on('user-joined', ({ id, name }) => {
    if (iAmHost && isPrivateMode && !allowedGuests.some(g => g.toLowerCase() === name.toLowerCase())) { socket.emit('kick-user', id); return; }
    appendChat($('chatLogPrivate'), 'System', `${name} joined`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
});
socket.on('user-left', ({ id }) => { if (viewerPeers[id]) { viewerPeers[id].close(); delete viewerPeers[id]; } endPeerCall(id, true); });
socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users; currentOwnerId = ownerId;
    if ($('streamTitleInput')) $('streamTitleInput').value = streamTitle;
    if ($('lockRoomBtn')) { $('lockRoomBtn').textContent = locked ? 'Unlock Room' : 'Lock Room'; $('lockRoomBtn').onclick = () => { if(iAmHost) socket.emit('lock-room', !locked); }; }
    renderUserList();
});
socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    if($('localContainer')) $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});

// ======================================================
// 11. CONTROLS
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
if ($('addGuestBtn')) $('addGuestBtn').onclick = () => { const val = $('guestNameInput').value.trim(); if(val && !allowedGuests.includes(val)) { allowedGuests.push(val); renderGuestList(); $('guestNameInput').value=''; } };
function renderGuestList() { $('guestListDisplay').innerHTML = ''; allowedGuests.forEach(n => { const s = document.createElement('span'); s.textContent = n; s.style.cssText="background:var(--accent);color:#000;padding:2px 6px;border-radius:4px;font-size:0.7rem;"; $('guestListDisplay').appendChild(s); }); }

function appendChat(log, name, text, ts) {
    const d = document.createElement('div'); d.className = 'chat-line';
    const s = document.createElement('strong'); s.textContent = name;
    const t = document.createElement('small'); t.textContent = new Date(ts).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    d.append(s, document.createTextNode(' '), t, txt);
    log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function sendChat(type) {
    const inp = $(type === 'public' ? 'inputPublic' : 'inputPrivate'); const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit(`${type}-chat`, { room: currentRoom, name: userName, text }); inp.value = '';
}
$('btnSendPublic').onclick = () => sendChat('public'); $('inputPublic').onkeydown = e => { if(e.key==='Enter') sendChat('public'); };
$('btnSendPrivate').onclick = () => sendChat('private'); $('inputPrivate').onkeydown = e => { if(e.key==='Enter') sendChat('private'); };
socket.on('public-chat', d => { appendChat($('chatLogPublic'), d.name, d.text, d.ts); if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); });
socket.on('private-chat', d => { appendChat($('chatLogPrivate'), d.name, d.text, d.ts); if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); });
if ($('emojiStripPublic')) $('emojiStripPublic').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; };
if ($('emojiStripPrivate')) $('emojiStripPrivate').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; };

$('fileInput').onchange = () => { if($('fileInput').files.length) { $('fileNameLabel').textContent = $('fileInput').files[0].name; $('sendFileBtn').disabled = false; } };
$('sendFileBtn').onclick = () => {
    const file = $('fileInput').files[0];
    if(file.size > 1024*1024) return alert("File too big (1MB Limit). Use Arcade.");
    const r = new FileReader();
    r.onload = () => { socket.emit('file-share', { room: currentRoom, name: userName, fileName: file.name, fileData: r.result }); $('sendFileBtn').disabled=true; $('fileNameLabel').textContent='Sent'; };
    r.readAsDataURL(file);
};
socket.on('file-share', d => {
    const div = document.createElement('div'); div.className = 'file-item';
    const info = document.createElement('div'); const b = document.createElement('strong'); b.textContent = d.name;
    info.append(b, document.createTextNode(` shared: ${d.fileName}`));
    const link = document.createElement('a'); link.href = d.fileData; link.download = d.fileName; link.className = 'btn small primary'; link.textContent = 'Download';
    div.append(info, link); $('fileLog').appendChild(div);
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});

if ($('arcadeInput')) $('arcadeInput').onchange = () => {
    const file = $('arcadeInput').files[0]; if(!file) return;
    activeToolboxFile = file; $('arcadeStatus').textContent = `Active Tool: ${file.name}`;
    Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
};

function renderUserList() {
    const list = $('userList'); list.innerHTML = '';
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        const div = document.createElement('div'); div.className = 'user-item';
        const nameSpan = document.createElement('span'); if (u.id === currentOwnerId) nameSpan.textContent = '👑 '; nameSpan.textContent += u.name;
        const actionsDiv = document.createElement('div'); actionsDiv.className = 'user-actions';
        const isCalling = !!callPeers[u.id];
        
        const callBtn = document.createElement('button'); callBtn.className = 'action-btn';
        callBtn.textContent = isCalling ? 'End Call' : 'Call';
        callBtn.onclick = () => isCalling ? endPeerCall(u.id) : window.ringUser(u.id);
        actionsDiv.appendChild(callBtn);

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
        const h2 = document.createElement('h2'); h2.textContent = callPeers[id] ? callPeers[id].name : "Guest"; d.appendChild(h2);
        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); if(v.srcObject !== stream) v.srcObject = stream;
}
function removeRemoteVideo(id) { const el = document.getElementById(`vid-${id}`); if(el) el.remove(); }
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);
if ($('openStreamBtn')) $('openStreamBtn').onclick = () => { const url = $('streamLinkInput').value; if(url) window.open(url, '_blank'); };
