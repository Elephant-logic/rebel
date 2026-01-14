// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
const CHUNK_SIZE = 16 * 1024; // 16KB chunks (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;
    const channel = pc.createDataChannel("side-load-pipe");
    channel.onopen = async () => {
        console.log(`[Arcade] Starting transfer of: ${file.name}`);
        channel.send(JSON.stringify({
            type: 'meta', name: file.name, size: file.size, mime: file.type
        }));
        const buffer = await file.arrayBuffer();
        let offset = 0;
        const sendLoop = () => {
            if (channel.bufferedAmount > MAX_BUFFER) { setTimeout(sendLoop, 10); return; }
            if (channel.readyState !== 'open') return;
            channel.send(buffer.slice(offset, offset + CHUNK_SIZE));
            offset += CHUNK_SIZE;
            if (onProgress) onProgress(Math.min(100, Math.round((offset / file.size) * 100)));
            if (offset < buffer.byteLength) setTimeout(sendLoop, 0); 
            else setTimeout(() => channel.close(), 1000);
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
let isBroadcastingGuest = false; // DIRECTOR MODE STATE

// --- AUDIO MIXER CONTEXT ---
let audioContext = null;
let audioDestination = null;

const viewerPeers = {}; 
const callPeers = {};   

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ======================================================
// 3. TAB NAVIGATION
// ======================================================
const tabs = { stream: $('tabStreamChat'), room: $('tabRoomChat'), files: $('tabFiles'), users: $('tabUsers') };
const contents = { stream: $('contentStreamChat'), room: $('contentRoomChat'), files: $('contentFiles'), users: $('contentUsers') };

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
// 4. DEVICE SETTINGS & MIXER
// ======================================================
const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); // SECONDARY INPUT
const videoSource = $('videoSource');
const videoQuality = $('videoQuality'); // RESOLUTION

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
                audioSource.appendChild(opt.cloneNode(true));
                audioSource2.appendChild(opt.cloneNode(true)); // Add to mixer too
            }
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });
    } catch (e) { console.error(e); }
}

audioSource.onchange = startLocalMedia;
audioSource2.onchange = startLocalMedia; // Update mix on change
videoSource.onchange = startLocalMedia;
videoQuality.onchange = startLocalMedia; // Update res on change

// ======================================================
// 5. MEDIA CONTROLS (MIXER + 1080p LOGIC)
// ======================================================
async function startLocalMedia() {
    if (isScreenSharing || isBroadcastingGuest) return; // Don't override if sharing screen or guest

    if (localStream) localStream.getTracks().forEach(t => t.stop());

    // 1. RESOLUTION LOGIC
    const quality = videoQuality.value;
    const videoConstraints = {
        deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
        width: quality === 'max' ? { ideal: 1920 } : (quality === 'low' ? { ideal: 640 } : { ideal: 1280 }),
        height: quality === 'max' ? { ideal: 1080 } : (quality === 'low' ? { ideal: 360 } : { ideal: 720 })
    };

    try {
        const mainStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
            video: videoConstraints
        });

        // 2. AUDIO MIXER LOGIC
        let finalAudioTrack = mainStream.getAudioTracks()[0];
        const secondaryId = audioSource2.value;

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

        const updatePC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            localStream.getTracks().forEach(t => {
                const sender = senders.find(s => s.track && s.track.kind === t.kind);
                if (sender) sender.replaceTrack(t);
            });
        };

        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));

        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { 
        console.error(e); 
        alert("Media failed. Check permissions or lower resolution."); 
    }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];
    if ($('toggleCamBtn')) {
        $('toggleCamBtn').textContent = (vTrack && vTrack.enabled) ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !(vTrack && vTrack.enabled));
    }
    if ($('toggleMicBtn')) {
        $('toggleMicBtn').textContent = (aTrack && aTrack.enabled) ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !(aTrack && aTrack.enabled));
    }
}

if ($('toggleMicBtn')) $('toggleMicBtn').onclick = () => { if(localStream) { const t = localStream.getAudioTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } };
if ($('toggleCamBtn')) $('toggleCamBtn').onclick = () => { if(localStream) { const t = localStream.getVideoTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } };

// ======================================================
// 6. SCREEN SHARING & DIRECTOR MODE
// ======================================================

// DIRECTOR MODE: Re-broadcast a guest's video
function toggleGuestBroadcast(guestId) {
    const guestPeer = callPeers[guestId];
    if (!guestPeer) return alert("Guest not connected!");

    // Find the DOM element and stream
    const vidEl = document.getElementById(`vid-${guestId}`)?.querySelector('video');
    const remoteStream = vidEl?.srcObject;
    const guestVideoTrack = remoteStream?.getVideoTracks()[0];

    if (!guestVideoTrack) return alert("Guest has no video!");

    if (isBroadcastingGuest) {
        // STOP -> Revert to Local
        console.log("Stopping Guest Broadcast");
        isBroadcastingGuest = false;
        startLocalMedia(); // Restart my cam
        document.getElementById(`vid-${guestId}`).classList.remove('live-source');
    } else {
        // START -> Switch to Guest
        console.log(`Broadcasting Guest: ${guestPeer.name}`);
        isBroadcastingGuest = true;
        
        // Replace track for all viewers
        Object.values(viewerPeers).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(guestVideoTrack);
        });

        // Show locally on main stage
        $('localVideo').srcObject = remoteStream;
        document.getElementById(`vid-${guestId}`).classList.add('live-source');
    }
}

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
                $('localVideo').srcObject = screenStream;
                const screenTrack = screenStream.getVideoTracks()[0];
                const updatePC = (pc) => {
                     if(!pc) return;
                     const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                     if(sender) sender.replaceTrack(screenTrack);
                };
                Object.values(viewerPeers).forEach(updatePC);
                Object.values(callPeers).forEach(p => updatePC(p.pc));
                screenTrack.onended = stopScreenShare;
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
    startLocalMedia(); // Revert to cam
}

// ======================================================
// 7. BROADCAST & CALLING
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
// 8. SOCKET & UI LOGIC
// ======================================================
socket.on('connect', () => { $('signalStatus').className = 'status-dot status-connected'; $('signalStatus').textContent = 'Connected'; myId = socket.id; });
socket.on('disconnect', () => { $('signalStatus').className = 'status-dot status-disconnected'; $('signalStatus').textContent = 'Disconnected'; });

$('joinBtn').onclick = () => {
    const room = $('roomInput').value.trim();
    if (!room) return;
    currentRoom = room; userName = $('nameInput').value.trim() || 'Host';
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    $('joinBtn').disabled = true; $('leaveBtn').disabled = false;
    updateLink(room);
    startLocalMedia();
};
if ($('leaveBtn')) $('leaveBtn').onclick = () => window.location.reload();

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}

socket.on('user-joined', ({ id, name }) => {
    if (iAmHost && isPrivateMode && !allowedGuests.some(g => g.toLowerCase() === name.toLowerCase())) {
        socket.emit('kick-user', id); return;
    }
    appendChat($('chatLogPrivate'), 'System', `${name} joined`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
});
socket.on('user-left', ({ id }) => { 
    if (viewerPeers[id]) { viewerPeers[id].close(); delete viewerPeers[id]; }
    endPeerCall(id, true);
});
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

// HOST EXTRAS
if ($('updateTitleBtn')) $('updateTitleBtn').onclick = () => socket.emit('update-stream-title', $('streamTitleInput').value.trim());
if ($('updateSlugBtn')) $('updateSlugBtn').onclick = () => updateLink($('slugInput').value.trim());
if ($('togglePrivateBtn')) $('togglePrivateBtn').onclick = () => {
    isPrivateMode = !isPrivateMode;
    $('togglePrivateBtn').textContent = isPrivateMode ? "ON" : "OFF";
    $('togglePrivateBtn').className = isPrivateMode ? "btn small danger" : "btn small secondary";
    $('guestListPanel').style.display = isPrivateMode ? "block" : "none";
    if (isPrivateMode) latestUserList.forEach(u => { if(u.id !== myId && !allowedGuests.some(g=>g.toLowerCase() === u.name.toLowerCase())) socket.emit('kick-user', u.id); });
};
if ($('addGuestBtn')) $('addGuestBtn').onclick = () => {
    const val = $('guestNameInput').value.trim();
    if(val && !allowedGuests.includes(val)) { allowedGuests.push(val); renderGuestList(); $('guestNameInput').value=''; }
};
function renderGuestList() {
    $('guestListDisplay').innerHTML = '';
    allowedGuests.forEach(n => { const s = document.createElement('span'); s.textContent = n; s.style.cssText="background:var(--accent);color:#000;padding:2px 6px;border-radius:4px;font-size:0.7rem;"; $('guestListDisplay').appendChild(s); });
}

// CHAT
function appendChat(log, name, text, ts) {
    const d = document.createElement('div'); d.className = 'chat-line';
    d.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text.replace(/</g, "&lt;")}`;
    log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function sendChat(type) {
    const inp = $(type === 'public' ? 'inputPublic' : 'inputPrivate');
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit(`${type}-chat`, { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPublic').onclick = () => sendChat('public');
$('btnSendPrivate').onclick = () => sendChat('private');
socket.on('public-chat', d => { appendChat($('chatLogPublic'), d.name, d.text, d.ts); if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); });
socket.on('private-chat', d => { appendChat($('chatLogPrivate'), d.name, d.text, d.ts); if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); });

// FILES
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
    div.innerHTML = `<strong>${d.name}</strong> shared: ${d.fileName} <a href="${d.fileData}" download="${d.fileName}" class="btn small primary">Download</a>`;
    $('fileLog').appendChild(div);
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});

// ARCADE
if ($('arcadeInput')) $('arcadeInput').onchange = () => {
    const file = $('arcadeInput').files[0];
    if(!file) return;
    activeToolboxFile = file;
    $('arcadeStatus').textContent = `Active: ${file.name}`;
    Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
};

// USER LIST & DIRECTOR CONTROLS
function renderUserList() {
    const list = $('userList'); list.innerHTML = '';
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        const div = document.createElement('div'); div.className = 'user-item';
        div.innerHTML = `<span>${u.id === currentOwnerId ? '👑 ' : ''}${u.name}</span>`;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'user-actions';
        
        // CALL BUTTON
        const isCalling = !!callPeers[u.id];
        const callBtn = document.createElement('button');
        callBtn.className = 'action-btn';
        callBtn.textContent = isCalling ? 'End Call' : 'Call';
        callBtn.onclick = () => isCalling ? endPeerCall(u.id) : callPeer(u.id);
        actionsDiv.appendChild(callBtn);

        // DIRECTOR MODE BUTTON (Broadcast Guest)
        if (isCalling && iAmHost) {
            const shareBtn = document.createElement('button');
            shareBtn.className = 'action-btn';
            shareBtn.textContent = '📺 Share';
            shareBtn.title = "Broadcast this user to stream";
            shareBtn.onclick = () => toggleGuestBroadcast(u.id);
            actionsDiv.appendChild(shareBtn);
        }

        if (iAmHost) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'action-btn kick';
            kickBtn.textContent = 'Kick';
            kickBtn.onclick = () => socket.emit('kick-user', u.id);
            actionsDiv.appendChild(kickBtn);
        }
        div.appendChild(actionsDiv);
        list.appendChild(div);
    });
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`;
        d.innerHTML = `<video autoplay playsinline></video><h2>${callPeers[id]?.name || 'Guest'}</h2>`;
        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video');
    if(v.srcObject !== stream) v.srcObject = stream;
}

function removeRemoteVideo(id) { const el = document.getElementById(`vid-${id}`); if(el) el.remove(); }
if ($('openStreamBtn')) $('openStreamBtn').onclick = () => { const url = $('streamLinkInput').value; if(url) window.open(url, '_blank'); };
