// ======================================================
// 1. ARCADE ENGINE (P2P Binary Transfer Protocol)
// ======================================================
// Chunks files into 16KB packets to bypass browser memory limits.
// This version is memory-safe: it slices the file on the fly.

const CHUNK_SIZE = 16 * 1024; // 16KB (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Max Buffer before pausing

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;
    
    const channel = pc.createDataChannel("side-load-pipe");
    
    channel.onopen = async () => {
        console.log(`[Arcade] Starting transfer of: ${file.name}`);

        const metadata = JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            mime: file.type
        });
        channel.send(metadata);

        let offset = 0;

        const sendLoop = async () => {
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }

            if (channel.readyState !== 'open') return;

            // FIX: Slice on demand to handle GB-sized files without crashing RAM
            const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
            const chunkBuffer = await chunkBlob.arrayBuffer();
            
            channel.send(chunkBuffer);
            offset += CHUNK_SIZE;

            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            if (offset < file.size) {
                setTimeout(sendLoop, 0); 
            } else {
                console.log(`[Arcade] Transfer Complete: ${file.name}`);
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

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let wasHost = false; 
let latestUserList = [];
let currentOwnerId = null;

let isPrivateMode = false;
let allowedGuests = [];

let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false; 

let activeToolboxFile = null;

// Mixer State
let audioContext = null;
let audioDestination = null;
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 
let mixerLayout = 'SOLO'; 
let activeGuestId = null;

// QR Overlay State
let qrcodeInstance = null;
let qrImage = new Image();
let showQrOnStream = true; 

const viewerPeers = {}; 
const callPeers = {};   

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
            ctx.fillText("Waiting for Guest Signal...", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        const slotW = 960;
        const vidH = 540; 
        const yOffset = (1080 - vidH) / 2;

        if (myVideo && myVideo.readyState === 4) ctx.drawImage(myVideo, 0, yOffset, slotW, vidH);
        if (guestVideo && guestVideo.readyState === 4) ctx.drawImage(guestVideo, 960, yOffset, slotW, vidH);
        
        ctx.strokeStyle = '#222'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(960, 0); ctx.lineTo(960, 1080); ctx.stroke();
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
    else if (mixerLayout === 'PIP_REV') {
        if (guestVideo && guestVideo.readyState === 4) ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        if (myVideo && myVideo.readyState === 4) {
            const pipW = 480; const pipH = 270; const padding = 30;
            const x = canvas.width - pipW - padding; const y = canvas.height - pipH - padding;
            ctx.strokeStyle = "#4af3a3"; ctx.lineWidth = 5; ctx.strokeRect(x, y, pipW, pipH);
            ctx.drawImage(myVideo, x, y, pipW, pipH);
        }
    }

    // QR OVERLAY
    if (showQrOnStream && qrImage && qrImage.src) {
        const qrSize = 180; const margin = 30;
        ctx.fillStyle = "white";
        ctx.fillRect(canvas.width - qrSize - margin - 5, margin - 5, qrSize + 10, qrSize + 10);
        ctx.drawImage(qrImage, canvas.width - qrSize - margin, margin, qrSize, qrSize);
        ctx.fillStyle = "black"; ctx.font = "bold 18px Arial"; ctx.textAlign = "center";
        ctx.fillText("SCAN TO JOIN", canvas.width - (qrSize/2) - margin, margin + qrSize + 25);
    }

    requestAnimationFrame(drawMixer);
}

canvasStream = canvas.captureStream(30); 
drawMixer();

window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active');
        if (b.onclick.toString().includes(mode)) b.classList.add('active');
    });
};

window.setActiveGuest = (id) => { activeGuestId = id; renderUserList(); };

window.toggleQrOnStream = () => {
    showQrOnStream = !showQrOnStream;
    const btn = $('toggleQrBtn');
    if(btn) btn.textContent = showQrOnStream ? "QR On Stream: ON" : "QR On Stream: OFF";
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
    tabs[name].classList.add('active');
    contents[name].classList.add('active');
    tabs[name].classList.remove('has-new');
}
Object.keys(tabs).forEach(k => tabs[k].onclick = () => switchTab(k));


// ======================================================
// 5. DEVICE SETTINGS
// ======================================================

const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); 
const videoSource = $('videoSource');
const videoQuality = $('videoQuality');

if ($('settingsBtn')) {
    $('settingsBtn').onclick = () => { settingsPanel.style.display = 'block'; getDevices(); };
}
if ($('closeSettingsBtn')) {
    $('closeSettingsBtn').onclick = () => settingsPanel.style.display = 'none';
}

async function getDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        audioSource.innerHTML = ''; videoSource.innerHTML = '';
        if(audioSource2) audioSource2.innerHTML = '<option value="">-- None --</option>';

        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId; opt.text = d.label || d.kind;
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
                if(audioSource2) audioSource2.appendChild(opt.cloneNode(true));
            }
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });
    } catch (e) { console.error(e); }
}

audioSource.onchange = startLocalMedia;
if(audioSource2) audioSource2.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;
if(videoQuality) videoQuality.onchange = startLocalMedia;


// ======================================================
// 6. MEDIA CONTROLS
// ======================================================

async function startLocalMedia() {
    if (isScreenSharing) return; 
    if (localStream) localStream.getTracks().forEach(t => t.stop());

    try {
        const quality = videoQuality ? videoQuality.value : 'ideal';
        let resW = 1280, resH = 720;
        if (quality === 'max') { resW = 1920; resH = 1080; }
        if (quality === 'low') { resW = 640; resH = 360; }

        const constraints = {
            audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
            video: { deviceId: videoSource.value ? { exact: videoSource.value } : undefined, width: { ideal: resW }, height: { ideal: resH } }
        };

        const mainStream = await navigator.mediaDevices.getUserMedia(constraints);
        let finalAudioTrack = mainStream.getAudioTracks()[0];

        if (audioSource2 && audioSource2.value) {
            const secStream = await navigator.mediaDevices.getUserMedia({ audio: { exact: audioSource2.value } });
            if(!audioContext) audioContext = new AudioContext();
            audioDestination = audioContext.createMediaStreamDestination();
            audioContext.createMediaStreamSource(mainStream).connect(audioDestination);
            audioContext.createMediaStreamSource(secStream).connect(audioDestination);
            finalAudioTrack = audioDestination.stream.getAudioTracks()[0];
        }

        localStream = new MediaStream([mainStream.getVideoTracks()[0], finalAudioTrack]);
        $('localVideo').srcObject = localStream;

        const mixedVideoTrack = canvasStream.getVideoTracks()[0];
        Object.values(viewerPeers).forEach(pc => {
            pc.getSenders().forEach(s => {
                if(s.track.kind === 'video') s.replaceTrack(mixedVideoTrack);
                if(s.track.kind === 'audio') s.replaceTrack(finalAudioTrack);
            });
        });
        Object.values(callPeers).forEach(p => {
            p.pc.getSenders().forEach(s => {
                if(s.track.kind === 'video') s.replaceTrack(mainStream.getVideoTracks()[0]);
                if(s.track.kind === 'audio') s.replaceTrack(finalAudioTrack);
            });
        });

        $('hangupBtn').disabled = false;
        updateMediaButtons();
    } catch (e) { console.error(e); }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vt = localStream.getVideoTracks()[0];
    const at = localStream.getAudioTracks()[0];
    if ($('toggleCamBtn')) {
        $('toggleCamBtn').textContent = vt.enabled ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !vt.enabled);
    }
    if ($('toggleMicBtn')) {
        $('toggleMicBtn').textContent = at.enabled ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !at.enabled);
    }
}

$('toggleMicBtn').onclick = () => { if (localStream) { localStream.getAudioTracks()[0].enabled = !localStream.getAudioTracks()[0].enabled; updateMediaButtons(); } };
$('toggleCamBtn').onclick = () => { if (localStream) { localStream.getVideoTracks()[0].enabled = !localStream.getVideoTracks()[0].enabled; updateMediaButtons(); } };


// ======================================================
// 7. SCREEN SHARING
// ======================================================

$('shareScreenBtn').onclick = async () => {
    if (isScreenSharing) { stopScreenShare(); }
    else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            isScreenSharing = true;
            $('shareScreenBtn').textContent = 'Stop Screen'; $('shareScreenBtn').classList.add('danger');
            $('localVideo').srcObject = screenStream;
            const vt = screenStream.getVideoTracks()[0];
            Object.values(callPeers).forEach(p => { p.pc.getSenders().forEach(s => { if(s.track.kind === 'video') s.replaceTrack(vt); }); });
            vt.onended = stopScreenShare;
        } catch(e) { console.error(e); }
    }
};

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    isScreenSharing = false;
    $('shareScreenBtn').textContent = 'Share Screen'; $('shareScreenBtn').classList.remove('danger');
    startLocalMedia();
}


// ======================================================
// 8. BROADCAST & STREAMING
// ======================================================

$('startStreamBtn').onclick = async () => {
    if (!iAmHost) return;
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
};

$('hangupBtn').onclick = () => { Object.keys(callPeers).forEach(id => endPeerCall(id)); };

// ======================================================
// 9. P2P CALLING LOGIC
// ======================================================

socket.on('ring-alert', async ({ from, fromId }) => { if (confirm(`Incoming call from ${from}. Accept?`)) await callPeer(fromId); });

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

function endPeerCall(id, isIncomingSignal) {
    if (callPeers[id]) { try { callPeers[id].pc.close(); } catch(e){} }
    delete callPeers[id]; removeRemoteVideo(id);
    if (!isIncomingSignal) socket.emit('call-end', { targetId: id });
    renderUserList();
}
socket.on('call-end', ({ from }) => endPeerCall(from, true));


// ======================================================
// 10. VIEWER SIGNALLING
// ======================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    pc.createDataChannel("control");
    pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); };
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    if(localStream) {
        const at = localStream.getAudioTracks()[0];
        if(at) pc.addTrack(at, canvasStream);
    }
    if (activeToolboxFile) pushFileToPeer(pc, activeToolboxFile, null);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => { if (viewerPeers[from]) await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp)); });
socket.on('webrtc-ice-candidate', async ({ from, candidate }) => { if (viewerPeers[from]) await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate)); });


// ======================================================
// 11. ROOM & ROLE (Auto-Takeover Corrected)
// ======================================================

socket.on('connect', () => { $('signalStatus').className = 'status-dot status-connected'; $('signalStatus').textContent = 'Connected'; myId = socket.id; });

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    const fullUrl = url.toString();
    $('streamLinkInput').value = fullUrl;
    
    if ($('qrcode')) {
        if (!qrcodeInstance) qrcodeInstance = new QRCode($('qrcode'), { text: fullUrl, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.H });
        else qrcodeInstance.makeCode(fullUrl);
        setTimeout(() => { const c = $('qrcode').querySelector('canvas'); if (c) qrImage.src = c.toDataURL(); }, 500);
    }
}

socket.on('role', async ({ isHost }) => {
    // FIX: Only trigger Auto-Takeover if already a connected member (myId set)
    if (!wasHost && isHost && myId !== null) {
        const notify = document.createElement('div');
        notify.style.cssText = "position:fixed; top:20px; left:50%; transform:translateX(-50%); background:var(--accent); color:#000; padding:10px 20px; border-radius:20px; font-weight:bold; z-index:9999;";
        notify.textContent = "👑 HOST LEFT — YOU ARE NOW BROADCASTING!";
        document.body.appendChild(notify); setTimeout(() => notify.remove(), 4000);
        if (!localStream) await startLocalMedia();
        if (!isStreaming) { iAmHost = true; $('startStreamBtn').click(); }
    }
    iAmHost = isHost; wasHost = isHost;
    if ($('localContainer')) $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});

$('joinBtn').onclick = () => {
    currentRoom = $('roomInput').value.trim(); userName = $('nameInput').value.trim() || 'Host';
    if(!currentRoom) return;
    socket.connect(); socket.emit('join-room', { room: currentRoom, name: userName });
    updateLink(currentRoom); startLocalMedia();
    $('joinBtn').disabled = true; $('leaveBtn').disabled = false;
};

socket.on('room-update', d => { latestUserList = d.users; currentOwnerId = d.ownerId; renderUserList(); });
socket.on('user-joined', d => {
    if (iAmHost && isPrivateMode && !allowedGuests.some(g => g.toLowerCase() === d.name.toLowerCase())) {
        socket.emit('kick-user', d.id); return;
    }
    if (iAmHost && isStreaming) connectViewer(d.id);
});


// ======================================================
// 12. CHAT & FILES (50MB Limit)
// ======================================================

function appendChat(log, name, text) {
    const d = document.createElement('div'); d.className = 'chat-line';
    const s = document.createElement('strong'); s.textContent = name;
    d.appendChild(s); d.appendChild(document.createTextNode(': ' + text));
    log.appendChild(d); log.scrollTop = log.scrollHeight;
}

$('btnSendPublic').onclick = () => { 
    const val = $('inputPublic').value.trim(); if(!val) return;
    socket.emit('public-chat', { room: currentRoom, name: userName, text: val }); $('inputPublic').value = ''; 
};
socket.on('public-chat', d => { appendChat($('chatLogPublic'), d.name, d.text); if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); });

$('sendFileBtn').onclick = () => {
    const file = $('fileInput').files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) return alert("File too large (Max 50MB)");
    const reader = new FileReader();
    reader.onload = () => {
        socket.emit('file-share', { room: currentRoom, name: userName, fileName: file.name, fileData: reader.result });
        $('fileInput').value = ''; $('fileNameLabel').textContent = 'No file selected'; $('sendFileBtn').disabled = true;
    };
    reader.readAsDataURL(file);
};

socket.on('file-share', d => {
    const div = document.createElement('div'); div.className = 'file-item';
    div.innerHTML = `<span><strong>${d.name}</strong> shared ${d.fileName}</span> <a href="${d.fileData}" download="${d.fileName}" class="btn small primary">Download</a>`;
    $('fileLog').appendChild(div); if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ======================================================
// 13. USER LIST (Director Features & Mute)
// ======================================================

function renderUserList() {
    const list = $('userList'); list.innerHTML = '';
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        const div = document.createElement('div'); div.className = 'user-item';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = (u.id === currentOwnerId ? '👑 ' : '') + u.name;
        div.appendChild(nameSpan);

        const actions = document.createElement('div'); actions.className = 'user-actions';

        if (callPeers[u.id]) {
            const vidContainer = document.getElementById(`vid-${u.id}`);
            const vid = vidContainer ? vidContainer.querySelector('video') : null;
            if (vid) {
                const mBtn = document.createElement('button'); mBtn.className = 'action-btn';
                mBtn.textContent = vid.muted ? '🔊' : '🔇';
                mBtn.onclick = () => { vid.muted = !vid.muted; renderUserList(); };
                actions.appendChild(mBtn);
            }
            const endBtn = document.createElement('button'); endBtn.className = 'action-btn danger'; endBtn.textContent = 'End';
            endBtn.onclick = () => endPeerCall(u.id); actions.appendChild(endBtn);
            
            if(iAmHost) {
                const selBtn = document.createElement('button'); selBtn.className = 'action-btn';
                selBtn.textContent = (activeGuestId === u.id) ? 'Live' : 'Mix';
                selBtn.onclick = () => window.setActiveGuest(u.id);
                actions.appendChild(selBtn);
            }
        } else {
            const cBtn = document.createElement('button'); cBtn.className = 'action-btn'; cBtn.textContent = 'Call';
            cBtn.onclick = () => socket.emit('ring-user', u.id); actions.appendChild(cBtn);
        }

        if (iAmHost) {
            const pBtn = document.createElement('button'); pBtn.className = 'action-btn'; pBtn.textContent = '👑';
            pBtn.onclick = () => { if(confirm("Pass Host?")) socket.emit('promote-host', u.id); };
            actions.appendChild(pBtn);
            const kBtn = document.createElement('button'); kBtn.className = 'action-btn kick'; kBtn.textContent = 'Kick';
            kBtn.onclick = () => { if(confirm("Kick?")) socket.emit('kick-user', u.id); };
            actions.appendChild(kBtn);
        }
        div.appendChild(actions); list.appendChild(div);
    });
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`;
        d.innerHTML = `<video autoplay playsinline></video><h2>${callPeers[id] ? callPeers[id].name : 'Guest'}</h2>`;
        $('videoGrid').appendChild(d);
    }
    d.querySelector('video').srcObject = stream;
}

function removeRemoteVideo(id) { const el = document.getElementById(`vid-${id}`); if(el) el.remove(); }

$('arcadeInput').onchange = () => {
    const file = $('arcadeInput').files[0]; if(!file) return;
    activeToolboxFile = file; $('arcadeStatus').textContent = "Loaded: " + file.name;
    Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
};

// Global exports
window.ringUser = (id) => socket.emit('ring-user', id);
window.kickUser = (id) => socket.emit('kick-user', id);
window.makeHost = (id) => socket.emit('promote-host', id);
window.openStream = () => window.open($('streamLinkInput').value, '_blank');

socket.on('disconnect', () => { $('signalStatus').className = 'status-dot status-disconnected'; $('signalStatus').textContent = 'Disconnected'; });
