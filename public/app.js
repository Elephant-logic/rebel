// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFER = 256 * 1024;

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;
    try {
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

                if (offset < buffer.byteLength) {
                    setTimeout(sendLoop, 0);
                } else {
                    setTimeout(() => channel.close(), 1000);
                }
            };
            sendLoop();
        };
    } catch(err) { console.error("Arcade Error:", err); }
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
let mixedStream = null;      // NEW: For mixing Mic + System Audio
let audioContext = null;     // NEW: The Audio Engine
let isScreenSharing = false;
let isStreaming = false; 
let activeToolboxFile = null;

// --- CONNECTION STORAGE ---
const viewerPeers = {}; 
const callPeers = {};   

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ======================================================
// 3. TAB NAVIGATION INTERFACE
// ======================================================
const tabs = { 
    stream: $('tabStreamChat'), room: $('tabRoomChat'), 
    files: $('tabFiles'), users: $('tabUsers') 
};
const contents = { 
    stream: $('contentStreamChat'), room: $('contentRoomChat'), 
    files: $('contentFiles'), users: $('contentUsers') 
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
// 4. DEVICE SETTINGS
// ======================================================
const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const videoSource = $('videoSource');

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
        audioSource.innerHTML = ''; videoSource.innerHTML = '';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            if (d.kind === 'audioinput') audioSource.appendChild(opt);
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });
    } catch (e) { console.error(e); }
}


// ======================================================
// 5. MEDIA CONTROLS (PREMIUM AUDIO/VIDEO LOGIC)
// ======================================================
const audioProfile = $('audioProfile');
const videoQuality = $('videoQuality');

if(audioProfile) audioProfile.onchange = startLocalMedia;
if(videoQuality) videoQuality.onchange = startLocalMedia;
audioSource.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;

async function startLocalMedia() {
    // If sharing screen, don't override with camera
    if (isScreenSharing) return;

    // Stop previous tracks
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    // --- 1. VIDEO CONSTRAINTS ---
    // Default to 720p
    let videoConstraints = {
        deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
        width: { ideal: 1280 }, height: { ideal: 720 }
    };
    // If 1080p is selected
    if (videoQuality && videoQuality.value === '1080') {
        console.log("[Media] Switching to 1080p Premium Video");
        videoConstraints = {
            deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
            width: { ideal: 1920, max: 3840 }, height: { ideal: 1080, max: 2160 }, frameRate: { ideal: 30 }
        };
    }

    // --- 2. AUDIO CONSTRAINTS ---
    // Default to Voice
    let audioConstraints = {
        deviceId: audioSource.value ? { exact: audioSource.value } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
    };
    // If Music / DJ Mode is selected
    if (audioProfile && audioProfile.value === 'music') {
        console.log("[Media] Switching to Music/DJ Audio Profile");
        audioConstraints = {
            deviceId: audioSource.value ? { exact: audioSource.value } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: 2, sampleRate: 48000, sampleSize: 16
        };
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: videoConstraints
        });
        
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; 

        // Update all connected peers with new stream
        const tracks = localStream.getTracks();
        const updatePC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            tracks.forEach(t => {
                const sender = senders.find(s => s.track && s.track.kind === t.kind);
                if (sender) sender.replaceTrack(t);
            });
        };

        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));

        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { 
        console.error("Media Error:", e); 
        alert("Could not start media. If using 1080p, ensure your camera supports it."); 
    }
}

function updateMediaButtons() {
    if (!localStream) return;
    const v = localStream.getVideoTracks()[0];
    const a = localStream.getAudioTracks()[0];
    if ($('toggleCamBtn')) {
        const on = v && v.enabled;
        $('toggleCamBtn').textContent = on ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !on);
    }
    if ($('toggleMicBtn')) {
        const on = a && a.enabled;
        $('toggleMicBtn').textContent = on ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !on);
    }
}
if($('toggleMicBtn')) $('toggleMicBtn').onclick = () => { if(localStream) { const t=localStream.getAudioTracks()[0]; if(t) { t.enabled=!t.enabled; updateMediaButtons(); } } };
if($('toggleCamBtn')) $('toggleCamBtn').onclick = () => { if(localStream) { const t=localStream.getVideoTracks()[0]; if(t) { t.enabled=!t.enabled; updateMediaButtons(); } } };


// ======================================================
// 6. SCREEN SHARING (WITH DESKTOP AUDIO MIXER)
// ======================================================
if ($('shareScreenBtn')) {
    $('shareScreenBtn').addEventListener('click', async () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                    video: true, 
                    audio: true // Request System Audio
                });
                
                isScreenSharing = true;
                $('shareScreenBtn').textContent = 'Stop Screen';
                $('shareScreenBtn').classList.add('danger');
                $('localVideo').srcObject = screenStream;

                // --- AUDIO MIXER ---
                const screenAudioTrack = screenStream.getAudioTracks()[0];
                const micAudioTrack = localStream ? localStream.getAudioTracks()[0] : null;
                let finalAudioTrack = micAudioTrack; 

                if (screenAudioTrack && micAudioTrack) {
                    console.log("[Mixer] Mixing Mic + Desktop Audio");
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    const dest = audioContext.createMediaStreamDestination();
                    audioContext.createMediaStreamSource(new MediaStream([micAudioTrack])).connect(dest);
                    audioContext.createMediaStreamSource(new MediaStream([screenAudioTrack])).connect(dest);
                    mixedStream = dest.stream;
                    finalAudioTrack = mixedStream.getAudioTracks()[0];
                } else if (screenAudioTrack) {
                    finalAudioTrack = screenAudioTrack;
                }

                // --- UPDATE PEERS ---
                const screenVideoTrack = screenStream.getVideoTracks()[0];
                const updatePC = (pc) => {
                     if(!pc) return;
                     const senders = pc.getSenders();
                     const vSender = senders.find(s => s.track && s.track.kind === 'video');
                     if(vSender) vSender.replaceTrack(screenVideoTrack);
                     const aSender = senders.find(s => s.track && s.track.kind === 'audio');
                     if(aSender && finalAudioTrack) aSender.replaceTrack(finalAudioTrack);
                };

                Object.values(viewerPeers).forEach(updatePC);
                Object.values(callPeers).forEach(p => updatePC(p.pc));
                screenVideoTrack.onended = stopScreenShare;

            } catch(e) { console.error("Screen share cancelled", e); }
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    
    if (audioContext) { audioContext.close(); audioContext = null; }
    mixedStream = null;
    screenStream = null;
    isScreenSharing = false;
    
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    $('localVideo').srcObject = localStream;
    
    if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        const micTrack = localStream.getAudioTracks()[0];
        const updatePC = (pc) => {
             if(!pc) return;
             const senders = pc.getSenders();
             const vSender = senders.find(s => s.track && s.track.kind === 'video');
             if(vSender && camTrack) vSender.replaceTrack(camTrack);
             const aSender = senders.find(s => s.track && s.track.kind === 'audio');
             if(aSender && micTrack) aSender.replaceTrack(micTrack);
        };
        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));
    }
}


// ======================================================
// 7. BROADCAST STREAMING
// ======================================================
if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) return alert("Host only.");
        
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
            latestUserList.forEach(u => { 
                if (u.id !== myId) connectViewer(u.id); 
            });
        }
    });
}


// ======================================================
// 8. P2P CALLING
// ======================================================
if ($('hangupBtn')) $('hangupBtn').onclick = () => Object.keys(callPeers).forEach(id => endPeerCall(id));

socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`Incoming call from ${from}. Accept?`)) await callPeer(fromId);
});

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
// 9. WEBRTC SIGNALING (BROADCAST)
// ======================================================
async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); };
    
    const stream = isScreenSharing ? screenStream : localStream;
    if(stream) stream.getTracks().forEach(t => pc.addTrack(t, stream));
    
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

$('joinBtn').addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    if (!room) return;
    currentRoom = room; 
    userName = $('nameInput').value.trim() || 'Host';
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    $('joinBtn').disabled = true; 
    $('leaveBtn').disabled = false;
    updateLink(room);
    startLocalMedia();
});
if($('leaveBtn')) $('leaveBtn').onclick = () => window.location.reload();

function updateLink(slug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(slug)}`;
    $('streamLinkInput').value = url.toString();
}

socket.on('user-joined', ({ id, name }) => {
    if (iAmHost && isPrivateMode) {
        if (!allowedGuests.some(g => g.toLowerCase() === name.toLowerCase())) {
            socket.emit('kick-user', id);
            return;
        }
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
    if ($('streamTitleInput')) $('streamTitleInput').value = streamTitle;
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
// 11. HOST CONTROLS
// ======================================================
if($('updateTitleBtn')) $('updateTitleBtn').onclick = () => socket.emit('update-stream-title', $('streamTitleInput').value.trim());
if($('updateSlugBtn')) $('updateSlugBtn').onclick = () => updateLink($('slugInput').value.trim());

if($('togglePrivateBtn')) {
    $('togglePrivateBtn').onclick = () => {
        isPrivateMode = !isPrivateMode;
        $('togglePrivateBtn').textContent = isPrivateMode ? "ON" : "OFF";
        $('togglePrivateBtn').className = isPrivateMode ? "btn small danger" : "btn small secondary";
        $('guestListPanel').style.display = isPrivateMode ? "block" : "none";
        if (isPrivateMode) {
            latestUserList.forEach(u => {
                if (u.id !== myId && !allowedGuests.some(g => g.toLowerCase() === u.name.toLowerCase())) {
                    socket.emit('kick-user', u.id);
                }
            });
        }
    };
}
if($('addGuestBtn')) $('addGuestBtn').onclick = () => {
    const val = $('guestNameInput').value.trim();
    if(val && !allowedGuests.includes(val)) { allowedGuests.push(val); renderGuestList(); $('guestNameInput').value = ''; }
};

function renderGuestList() {
    const d = $('guestListDisplay'); d.innerHTML = '';
    allowedGuests.forEach(name => {
        const s = document.createElement('span');
        s.style.cssText = "background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem;";
        s.textContent = name;
        d.appendChild(s);
    });
}


// ======================================================
// 12. CHAT & FILES
// ======================================================
function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    const s = document.createElement('strong'); s.textContent = name;
    const time = document.createElement('small'); time.textContent = new Date(ts).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    d.append(s, " ", time, txt);
    log.appendChild(d); log.scrollTop = log.scrollHeight;
}

function sendPublic() {
    const val = $('inputPublic').value.trim();
    if(val && currentRoom) { socket.emit('public-chat', { room: currentRoom, name: userName, text: val }); $('inputPublic').value = ''; }
}
function sendPrivate() {
    const val = $('inputPrivate').value.trim();
    if(val && currentRoom) { socket.emit('private-chat', { room: currentRoom, name: userName, text: val }); $('inputPrivate').value = ''; }
}

$('btnSendPublic').onclick = sendPublic; $('inputPublic').onkeydown = e => { if(e.key==='Enter') sendPublic(); };
$('btnSendPrivate').onclick = sendPrivate; $('inputPrivate').onkeydown = e => { if(e.key==='Enter') sendPrivate(); };

socket.on('public-chat', d => { appendChat($('chatLogPublic'), d.name, d.text, d.ts); if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); });
socket.on('private-chat', d => { appendChat($('chatLogPrivate'), d.name, d.text, d.ts); if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); });

if ($('emojiStripPublic')) $('emojiStripPublic').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; };
if ($('emojiStripPrivate')) $('emojiStripPrivate').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; };

const fileInput = $('fileInput');
fileInput.onchange = () => { if(fileInput.files.length) { $('fileNameLabel').textContent = fileInput.files[0].name; $('sendFileBtn').disabled = false; } };

$('sendFileBtn').onclick = () => {
    const file = fileInput.files[0];
    if(file.size > 1024 * 1024) { return alert("File too large (1MB Limit). Use Arcade for P2P."); }
    if(!file || !currentRoom) return;
    const reader = new FileReader();
    reader.onload = () => {
        socket.emit('file-share', { room: currentRoom, name: userName, fileName: file.name, fileData: reader.result });
        fileInput.value = ''; $('fileNameLabel').textContent = 'No file selected'; $('sendFileBtn').disabled = true;
    };
    reader.readAsDataURL(file);
};

socket.on('file-share', d => {
    const div = document.createElement('div');
    div.className = 'file-item';
    const info = document.createElement('div');
    const bold = document.createElement('strong');
    bold.textContent = d.name;
    info.appendChild(bold);
    info.appendChild(document.createTextNode(` shared: ${d.fileName}`));
    const link = document.createElement('a');
    link.href = d.fileData;
    link.download = d.fileName;
    link.className = 'btn small primary';
    link.textContent = 'Download';
    div.append(info, link);
    $('fileLog').appendChild(div);
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ======================================================
// 13. ARCADE & USER LIST
// ======================================================
if($('arcadeInput')) $('arcadeInput').onchange = () => {
    const file = $('arcadeInput').files[0];
    if(file) { activeToolboxFile = file; $('arcadeStatus').textContent = `Active: ${file.name}`; Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file)); }
};

function renderUserList() {
    const list = $('userList'); list.innerHTML = ''; 
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        const div = document.createElement('div'); div.className = 'user-item';
        
        const nameSpan = document.createElement('span');
        if (u.id === currentOwnerId) nameSpan.textContent = "👑 ";
        nameSpan.textContent += u.name;
        
        const acts = document.createElement('div');
        acts.className = 'user-actions';

        const isCalling = !!callPeers[u.id];
        const callBtn = document.createElement('button');
        callBtn.className = 'action-btn';
        if (isCalling) {
            callBtn.textContent = 'End Call';
            callBtn.style.cssText = "border-color:var(--danger); color:var(--danger)";
            callBtn.onclick = () => endPeerCall(u.id);
        } else {
            callBtn.textContent = 'Call';
            callBtn.onclick = () => window.ringUser(u.id);
        }
        acts.appendChild(callBtn);

        if (iAmHost) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'action-btn kick';
            kickBtn.textContent = 'Kick';
            kickBtn.onclick = () => window.kickUser(u.id);
            acts.appendChild(kickBtn);
        }
        div.append(nameSpan, acts);
        list.appendChild(div);
    });
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`;
        const v = document.createElement('video'); v.autoplay = true; v.playsInline = true;
        d.appendChild(v); $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); if(v.srcObject !== stream) v.srcObject = stream;
}

function removeRemoteVideo(id) { const el = document.getElementById(`vid-${id}`); if(el) el.remove(); }

window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);

if ($('openStreamBtn')) $('openStreamBtn').onclick = () => { const url = $('streamLinkInput').value; if(url) window.open(url, '_blank'); };
