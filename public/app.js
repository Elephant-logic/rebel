// ======================================================
// 1. ARCADE & FILE ENGINE (P2P Transfer)
// ======================================================
// This handles splitting files into chunks and sending them 
// securely over WebRTC (bypassing server limits).

const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit

// Universal Sender (Works for Arcade AND Files)
async function pushFileToPeer(pc, file, type, onProgress) {
    if (!pc) return;

    // Create a specific data channel for this transfer
    // We use "side-load-pipe" for everything so it matches the working Arcade logic
    const channel = pc.createDataChannel("side-load-pipe");

    channel.onopen = async () => {
        console.log(`[P2P] Sending ${type}: ${file.name}`);

        // 1. Send Metadata
        const metadata = JSON.stringify({
            dataType: type, // 'arcade' (auto-launch) or 'file' (chat link)
            name: file.name,
            size: file.size,
            mime: file.type
        });
        channel.send(metadata);

        // 2. Read File
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
                console.log(`[P2P] Transfer Complete.`);
                setTimeout(() => channel.close(), 1000);
            }
        };
        sendLoop();
    };
}

// Receiver Logic (For App.js users - Host and Guests)
function setupDataReceiver(pc, peerId) {
    pc.ondatachannel = (e) => {
        const chan = e.channel;
        // Accept both pipe names just in case
        if (chan.label !== "side-load-pipe") return; 

        let chunks = [];
        let total = 0, curr = 0, meta = null;

        chan.onmessage = (evt) => {
            const data = evt.data;
            
            // 1. Metadata
            if(typeof data === 'string') {
                try { meta = JSON.parse(data); total = meta.size; } catch(e){}
            } 
            // 2. Binary Data
            else {
                chunks.push(data); curr += data.byteLength;
                
                if(curr >= total) {
                    const blob = new Blob(chunks, {type: meta?meta.mime:'application/octet-stream'});
                    const url = URL.createObjectURL(blob);
                    
                    // ROUTING: If it's a file, put it in chat
                    if (meta && meta.dataType === 'file') {
                        const name = callPeers[peerId] ? callPeers[peerId].name : "Guest";
                        addFileToChat(name, meta.name, url);
                    }
                    chan.close();
                }
            }
        };
    };
}

function addFileToChat(senderName, fileName, url) {
    const log = $('chatLogPrivate');
    const div = document.createElement('div');
    div.className = 'chat-line system-msg';
    div.innerHTML = `
        <div style="background: rgba(74, 243, 163, 0.1); border: 1px solid #4af3a3; padding: 10px; border-radius: 8px; margin: 10px 0;">
            <div><strong>${senderName}</strong> sent a file:</div>
            <div style="color:#fff; font-size:0.9rem; margin-bottom:5px;">${fileName}</div>
            <a href="${url}" download="${fileName}" class="btn small primary" style="text-decoration:none;">⬇️ Download</a>
        </div>
    `;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    
    // Notification
    if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new');
}


// ======================================================
// 2. MAIN APP SETUP & VARIABLES
// ======================================================
console.log("Rebel Stream Host App Loaded"); 

const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

// --- VARIABLES ---
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let latestUserList = [];
let currentOwnerId = null;

// --- VIP STATE ---
let isPrivateMode = false;
let allowedGuests = [];

// --- MEDIA STATE ---
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false; 

// --- ARCADE STATE ---
let activeToolboxFile = null;

// --- MIXER STATE ---
let audioContext = null;
let audioDestination = null;
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 
let mixerLayout = 'SOLO'; 
let activeGuestId = null; 

// --- PEERS ---
const viewerPeers = {}; // Broadcast (One-way)
const callPeers = {};   // Room (Two-way)

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ======================================================
// 3. CANVAS MIXER ENGINE
// ======================================================
function drawMixer() {
    if (!ctx) return;
    
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const myVideo = $('localVideo');
    let guestVideo = null;
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`);
        if(el) guestVideo = el.querySelector('video');
    }

    if (mixerLayout === 'SOLO') {
        if (myVideo && myVideo.readyState === 4) ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
    } 
    else if (mixerLayout === 'GUEST') {
        if (guestVideo && guestVideo.readyState === 4) ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        else {
            ctx.fillStyle = '#333'; ctx.fillRect(0,0,canvas.width, canvas.height);
            ctx.fillStyle = '#fff'; ctx.font = "60px Arial"; ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest...", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        // 16:9 Letterboxed Split
        const slotW = 960; const vidH = 540; const yOffset = (1080 - vidH) / 2;
        if (myVideo && myVideo.readyState === 4) ctx.drawImage(myVideo, 0, yOffset, slotW, vidH);
        if (guestVideo && guestVideo.readyState === 4) ctx.drawImage(guestVideo, 960, yOffset, slotW, vidH);
        ctx.strokeStyle = '#222'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(960, 0); ctx.lineTo(960, 1080); ctx.stroke();
    }
    else if (mixerLayout === 'PIP') {
        if (myVideo && myVideo.readyState === 4) ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        if (guestVideo && guestVideo.readyState === 4) {
            const pipW = 480; const pipH = 270; const padding = 30;
            const x = canvas.width - pipW - padding; const y = canvas.height - pipH - padding;
            ctx.strokeStyle = "#4af3a3"; ctx.lineWidth = 5; ctx.strokeRect(x, y, pipW, pipH);
            ctx.drawImage(guestVideo, x, y, pipW, pipH);
        }
    }
    requestAnimationFrame(drawMixer);
}
canvasStream = canvas.captureStream(30);
drawMixer();

window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active');
        if (b.textContent.toUpperCase().includes(mode) || (mode==='PIP' && b.textContent.includes('Overlay'))) b.classList.add('active');
    });
};
window.setActiveGuest = (id) => { activeGuestId = id; alert("Guest Selected. Use Overlay/Split."); };


// ======================================================
// 4. TABS
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
// 5. SETTINGS
// ======================================================
const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); 
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
        audioSource.innerHTML = ''; videoSource.innerHTML = '';
        if(audioSource2) audioSource2.innerHTML = '<option value="">-- None --</option>';

        devices.forEach(d => {
            const opt = document.createElement('option'); opt.value = d.deviceId; opt.text = d.label || d.kind;
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
                if(audioSource2) audioSource2.appendChild(opt.cloneNode(true));
            }
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });
        
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at) audioSource.value = at.getSettings().deviceId;
            if (vt) videoSource.value = vt.getSettings().deviceId;
        }
    } catch (e) {}
}
audioSource.onchange = startLocalMedia;
if(audioSource2) audioSource2.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;
if(videoQuality) videoQuality.onchange = startLocalMedia;


// ======================================================
// 6. MEDIA
// ======================================================
async function startLocalMedia() {
    if (isScreenSharing) return;
    if (localStream) localStream.getTracks().forEach(t => t.stop());

    try {
        const quality = videoQuality ? videoQuality.value : 'ideal';
        let widthConstraint, heightConstraint;
        if (quality === 'max') { widthConstraint = { ideal: 1920 }; heightConstraint = { ideal: 1080 }; } 
        else if (quality === 'low') { widthConstraint = { ideal: 640 }; heightConstraint = { ideal: 360 }; } 
        else { widthConstraint = { ideal: 1280 }; heightConstraint = { ideal: 720 }; }

        const mainStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
            video: { deviceId: videoSource.value ? { exact: videoSource.value } : undefined, width: widthConstraint, height: heightConstraint }
        });

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

        // Broadcast Mix
        const mixedVideoTrack = canvasStream.getVideoTracks()[0];
        Object.values(viewerPeers).forEach(pc => {
            pc.getSenders().forEach(s => {
                if (s.track.kind === 'video') s.replaceTrack(mixedVideoTrack);
                if (s.track.kind === 'audio') s.replaceTrack(finalAudioTrack);
            });
        });
        
        // P2P Guests (Raw Cam)
        Object.values(callPeers).forEach(p => {
             p.pc.getSenders().forEach(s => {
                 if(s.track.kind === 'video') s.replaceTrack(mainStream.getVideoTracks()[0]);
                 if(s.track.kind === 'audio') s.replaceTrack(finalAudioTrack);
             });
        });

        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { console.error(e); alert("Camera access failed."); }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];
    if ($('toggleCamBtn')) {
        $('toggleCamBtn').textContent = (vTrack && vTrack.enabled) ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !vTrack.enabled);
    }
    if ($('toggleMicBtn')) {
        $('toggleMicBtn').textContent = (aTrack && aTrack.enabled) ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !aTrack.enabled);
    }
}
if ($('toggleMicBtn')) $('toggleMicBtn').onclick = () => { if (localStream) { const t = localStream.getAudioTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } };
if ($('toggleCamBtn')) $('toggleCamBtn').onclick = () => { if (localStream) { const t = localStream.getVideoTracks()[0]; if(t) { t.enabled = !t.enabled; updateMediaButtons(); } } };


// ======================================================
// 7. SCREEN SHARE
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
                $('localVideo').srcObject = screenStream; 
                
                // Update Guests with Screen
                const screenTrack = screenStream.getVideoTracks()[0];
                const screenAudio = screenStream.getAudioTracks()[0];
                Object.values(callPeers).forEach(p => {
                    p.pc.getSenders().forEach(s => {
                        if(s.track.kind === 'video') s.replaceTrack(screenTrack);
                        if(screenAudio && s.track.kind === 'audio') s.replaceTrack(screenAudio);
                    });
                });

                screenStream.getVideoTracks()[0].onended = stopScreenShare;
            } catch(e) { console.error(e); }
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
// 8. BROADCAST (ONE-TO-MANY)
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
// 9. P2P CALLS (ONE-TO-ONE)
// ======================================================
if ($('hangupBtn')) $('hangupBtn').onclick = () => Object.keys(callPeers).forEach(id => endPeerCall(id));
socket.on('ring-alert', async ({ from, fromId }) => { if (confirm(`Call from ${from}?`)) await callPeer(fromId); });

async function callPeer(targetId) {
    if (!localStream) await startLocalMedia();
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, name: "Peer" };
    
    // SETUP FILE RECEIVER FOR GUEST
    setupDataReceiver(pc, targetId);

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
    
    // SETUP FILE RECEIVER FOR GUEST
    setupDataReceiver(pc, from);

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
// 10. WEBRTC SIGNALING (BROADCAST)
// ======================================================
async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    pc.createDataChannel("control"); // Force pipe open

    pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); };
    
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    if(localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if(audioTrack) pc.addTrack(audioTrack, canvasStream);
    }
    
    // Auto-Push Arcade
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing to ${targetId}`);
        pushFileToPeer(pc, activeToolboxFile, 'arcade'); 
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => { if (viewerPeers[from]) await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp)); });
socket.on('webrtc-ice-candidate', async ({ from, candidate }) => { if (viewerPeers[from]) await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate)); });


// ======================================================
// 11. SOCKET & ROOM
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
    if (iAmHost && isPrivateMode && !allowedGuests.some(g => g.toLowerCase() === name.toLowerCase())) {
        socket.emit('kick-user', id); return;
    }
    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
});
socket.on('user-left', ({ id }) => { if (viewerPeers[id]) { viewerPeers[id].close(); delete viewerPeers[id]; } endPeerCall(id, true); });
socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users; currentOwnerId = ownerId;
    if (streamTitle && $('streamTitleInput')) $('streamTitleInput').value = streamTitle;
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
// 12. CONTROLS (Chat, Admin)
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
    d.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text.replace(/</g, "&lt;")}`;
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


// ======================================================
// 13. FILE SHARING (P2P REPLACEMENT)
// ======================================================
$('fileInput').onchange = () => { if($('fileInput').files.length) { $('fileNameLabel').textContent = $('fileInput').files[0].name; $('sendFileBtn').disabled = false; } };
$('sendFileBtn').onclick = () => {
    const file = $('fileInput').files[0];
    if(!file) return;
    
    const guests = Object.values(callPeers);
    if(guests.length === 0) return alert("No guests in the room to share with.");
    
    guests.forEach(p => {
        pushFileToPeer(p.pc, file, 'file', (pct) => {
            $('fileNameLabel').textContent = `Sending: ${pct}%`;
            if(pct >= 100) $('fileNameLabel').textContent = "Sent!";
        });
    });
    
    addFileToChat("You", file.name, URL.createObjectURL(file));
};

// ======================================================
// 14. ARCADE INPUT
// ======================================================
if ($('arcadeInput')) $('arcadeInput').onchange = () => {
    const file = $('arcadeInput').files[0]; if(!file) return;
    activeToolboxFile = file;
    $('arcadeStatus').textContent = `Active: ${file.name}`;
    
    let btn = document.getElementById('resendToolBtn');
    if(!btn) {
        btn = document.createElement('button'); btn.id = 'resendToolBtn';
        btn.textContent = 'Force Resend'; btn.className = 'btn small secondary full-width'; btn.style.marginTop = '5px';
        btn.onclick = () => { Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, activeToolboxFile, 'arcade')); alert("Resent."); };
        $('arcadeStatus').parentNode.appendChild(btn);
    }
    
    Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file, 'arcade'));
};

function renderUserList() {
    const list = $('userList'); list.innerHTML = '';
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        const div = document.createElement('div'); div.className = 'user-item';
        div.innerHTML = `<span>${u.id === currentOwnerId ? '👑 ' : ''}${u.name}</span>`;
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
        div.appendChild(actionsDiv); list.appendChild(div);
    });
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`;
        d.innerHTML = `<video autoplay playsinline></video><h2>${callPeers[id]?.name || 'Guest'}</h2>`;
        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); if(v.srcObject !== stream) v.srcObject = stream;
}
function removeRemoteVideo(id) { const el = document.getElementById(`vid-${id}`); if(el) el.remove(); }
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);
if ($('openStreamBtn')) $('openStreamBtn').onclick = () => { const url = $('streamLinkInput').value; if(url) window.open(url, '_blank'); };
