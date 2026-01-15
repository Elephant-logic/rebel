// ======================================================
//  REBEL STREAM HOST CLIENT (app.js)
//  - Chat
//  - 1-to-Many Stream with Canvas Mixer
//  - P2P Arcade Side-Loader
//  - VIP Room / Private Mode
//  - HTML Overlay Loader
// ======================================================

// Small helper
const $ = (id) => document.getElementById(id);

// Connect socket (but we will call connect() later)
const socket = io({ autoConnect: false });

// ICE CONFIG
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ------------------------------------------------------
// GLOBAL STATE
// ------------------------------------------------------
let currentRoom   = null;
let userName      = 'User';
let myId          = null;
let iAmHost       = false;

// STREAM PC (Host → Viewers)
let viewerPeers   = {};   // { socketId: RTCPeerConnection }
let isStreaming   = false;

// Local media
let localStream   = null;
let screenStream  = null;  // Active screen share stream (if any)
let isScreenSharing = false;

// For audio device selection
let audioSource   = null;
let audioSource2  = null;
let videoSource   = null;
let videoQuality  = null;

// Mixer canvas + preview
let mixerCanvas   = null;
let mixerCtx      = null;
let canvasStream  = null;
let currentLayout = 'SOLO'; // SOLO, GUEST, PIP, PIP_INVERTED, SPLIT

// DOM references
let localVideo    = null;
let videoGrid     = null;

// Users & roles
let latestUserList = [];
let currentOwnerId = null;

// Room controls
let roomLocked   = false;

// VIP / Private mode
let isPrivateMode = false;
let allowedGuests = [];  // list of names

// Arcade
let activeToolboxFile = null;

// HTML Overlay (layout file)
let overlayHtmlContent = '';
let overlayIframe = null;

// Preview Monitor
let previewModal = null;
let previewVideo = null;


// ======================================================
// 0. INIT / DOM READY
// ======================================================
document.addEventListener('DOMContentLoaded', async () => {
    localVideo   = $('localVideo');
    videoGrid    = $('videoGrid');
    previewModal = $('streamPreviewModal');
    previewVideo = $('streamPreviewVideo');

    // Settings panel references
    audioSource  = $('audioSource');
    audioSource2 = $('audioSource2');
    videoSource  = $('videoSource');
    videoQuality = $('videoQuality');

    setupTabs();
    wireButtons();
    setupEmojiStrips();
    setupFileUpload();
    setupArcade();
    setupHtmlSideLoader();
    setupVipPrivateMode();
    setupCanvasMixer();
    setupQrCode();

    // Populate device lists
    await refreshDeviceList();
});

// ======================================================
// 1. CANVAS MIXER ENGINE
// ======================================================

function setupCanvasMixer() {
    mixerCanvas = document.createElement('canvas');
    mixerCanvas.width  = 1280;
    mixerCanvas.height = 720;
    mixerCtx = mixerCanvas.getContext('2d');

    canvasStream = mixerCanvas.captureStream(30); // 30 FPS

    function drawMixerLoop() {
        mixerCtx.fillStyle = '#000';
        mixerCtx.fillRect(0, 0, mixerCanvas.width, mixerCanvas.height);

        const track = localStream ? localStream.getVideoTracks()[0] : null;
        const anyRemote = Object.values(viewerPeers).some(pc => {
            return pc.getReceivers().some(r => r.track && r.track.kind === 'video');
        });

        const lv = localVideo;
        const remoteVideoEl = document.querySelector('.remote-video-el');

        const W = mixerCanvas.width;
        const H = mixerCanvas.height;

        // Helper draw (safe)
        const drawVideoSafe = (videoEl, x, y, w, h) => {
            if (!videoEl || !videoEl.videoWidth) return;
            mixerCtx.save();
            mixerCtx.beginPath();
            mixerCtx.roundRect(x, y, w, h, 20);
            mixerCtx.clip();
            mixerCtx.drawImage(videoEl, x, y, w, h);
            mixerCtx.restore();
        };

        // LABEL
        mixerCtx.fillStyle = 'rgba(74,243,163,0.3)';
        mixerCtx.font = '20px system-ui';
        mixerCtx.fillText('Rebel Stream Mixer', 20, 40);

        if (!track && !remoteVideoEl) {
            // Nothing yet
            requestAnimationFrame(drawMixerLoop);
            return;
        }

        switch (currentLayout) {
            case 'SOLO':
                drawVideoSafe(lv, 0, 0, W, H);
                break;

            case 'GUEST':
                if (anyRemote && remoteVideoEl) {
                    drawVideoSafe(remoteVideoEl, 0, 0, W, H);
                } else {
                    drawVideoSafe(lv, 0, 0, W, H);
                }
                break;

            case 'PIP':
                if (anyRemote && remoteVideoEl) {
                    drawVideoSafe(remoteVideoEl, 0, 0, W, H);
                    const pipW = W / 4;
                    const pipH = H / 4;
                    drawVideoSafe(lv, W - pipW - 20, H - pipH - 20, pipW, pipH);
                } else {
                    drawVideoSafe(lv, 0, 0, W, H);
                }
                break;

            case 'PIP_INVERTED':
                if (anyRemote && remoteVideoEl) {
                    drawVideoSafe(lv, 0, 0, W, H);
                    const pipW = W / 4;
                    const pipH = H / 4;
                    drawVideoSafe(remoteVideoEl, W - pipW - 20, H - pipH - 20, pipW, pipH);
                } else {
                    drawVideoSafe(lv, 0, 0, W, H);
                }
                break;

            case 'SPLIT':
                if (anyRemote && remoteVideoEl) {
                    const mid = W / 2;
                    drawVideoSafe(lv, 0, 0, mid, H);
                    drawVideoSafe(remoteVideoEl, mid, 0, mid, H);
                } else {
                    drawVideoSafe(lv, 0, 0, W, H);
                }
                break;

            default:
                drawVideoSafe(lv, 0, 0, W, H);
        }

        requestAnimationFrame(drawMixerLoop);
    }

    requestAnimationFrame(drawMixerLoop);
}

function setMixerLayout(mode) {
    currentLayout = mode;
    document.querySelectorAll('.mixer-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.includes(mode === 'SOLO' ? 'Solo'
            : mode === 'GUEST' ? 'Guest'
            : mode === 'PIP' ? 'PiP (Guest Sm)'
            : mode === 'PIP_INVERTED' ? 'Inverted'
            : 'Split'));
    });
}


// ======================================================
// 2. HTML OVERLAY SIDE-LOADER
// ======================================================

function setupHtmlSideLoader() {
    overlayIframe = document.createElement('iframe');
    overlayIframe.style.position = 'fixed';
    overlayIframe.style.top = '0';
    overlayIframe.style.left = '0';
    overlayIframe.style.width = '100vw';
    overlayIframe.style.height = '100vh';
    overlayIframe.style.border = 'none';
    overlayIframe.style.zIndex = '9998';
    overlayIframe.style.pointerEvents = 'none';
    overlayIframe.style.background = 'transparent';
    overlayIframe.style.display = 'none';
    document.body.appendChild(overlayIframe);

    const input = $('htmlOverlayInput');
    if (!input) return;

    input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.type !== 'text/html') {
            alert('Please select an HTML file.');
            return;
        }
        const text = await file.text();
        overlayHtmlContent = text;

        const doc = overlayIframe.contentDocument || overlayIframe.contentWindow.document;
        doc.open();
        doc.write(text);
        doc.close();

        overlayIframe.style.display = 'block';
        $('overlayStatus').textContent = `[Loaded]: ${file.name}`;
    });
}

function clearOverlay() {
    overlayHtmlContent = '';
    const doc = overlayIframe.contentDocument || overlayIframe.contentWindow.document;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><style>body{margin:0;background:transparent;}</style></head><body></body></html>');
    doc.close();
    overlayIframe.style.display = 'none';
    $('overlayStatus').textContent = '[No Overlay]';
}


// ======================================================
// 3. ARCADE SIDE-LOADER (P2P FILE PUSH)
// ======================================================

const CHUNK_SIZE = 16 * 1024;    // Per-chunk size
const MAX_BUFFER = 256 * 1024;   // Back-pressure threshold

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

                if (offset < file.size) {
                    setTimeout(sendLoop, 0);
                } else {
                    console.log(`[Arcade] Completed: ${file.name}`);
                    channel.close();
                }
            };

            sendLoop();
        };
    } catch (err) {
        console.error('[Arcade] Error sending file:', err);
    }
}


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

function setupTabs() {
    tabs.stream.addEventListener('click', () => setTab('stream'));
    tabs.room.addEventListener('click', () => setTab('room'));
    tabs.files.addEventListener('click', () => setTab('files'));
    tabs.users.addEventListener('click', () => setTab('users'));
}

function setTab(which) {
    Object.keys(tabs).forEach(key => {
        tabs[key].classList.toggle('active', key === which);
        contents[key].classList.toggle('active', key === which);
    });
}


// ======================================================
// 5. DEVICE ENUMERATION & SETTINGS
// ======================================================

async function refreshDeviceList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        console.warn('enumerateDevices not supported.');
        return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();

    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const videoInputs = devices.filter(d => d.kind === 'videoinput');

    audioSource.innerHTML = '';
    audioInputs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Mic ${audioSource.length + 1}`;
        audioSource.appendChild(opt);
    });

    audioSource2.innerHTML = '';
    audioSource2.appendChild(new Option('-- None --', ''));
    audioInputs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Input ${audioSource2.length}`;
        audioSource2.appendChild(opt);
    });

    videoSource.innerHTML = '';
    videoInputs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${videoSource.length + 1}`;
        videoSource.appendChild(opt);
    });

    // Default selection
    if (audioSource.options.length > 0) audioSource.selectedIndex = 0;
    if (videoSource.options.length > 0) videoSource.selectedIndex = 0;
    if (audioSource2.options.length > 0) audioSource2.selectedIndex = 0;

    // Update media when dropdown changes
    audioSource.onchange = startLocalMedia;
    if(audioSource2) audioSource2.onchange = startLocalMedia;
    videoSource.onchange = startLocalMedia;
    if(videoQuality) videoQuality.onchange = startLocalMedia;
}


// ======================================================
// 6. MEDIA CONTROLS (CAMERA, MIC & MIXER ENGINE)
// ======================================================

async function startLocalMedia() {
    // If sharing screen, we don't want to kill the screen stream logic.
    // Screen sharing now feeds into "localStream" so the mixer picks the correct frame.
    if (isScreenSharing && screenStream) {
        console.log('[Media] Screen sharing active, skip camera re-init.');
        return;
    }

    const constraints = {
        audio: false,
        video: false
    };

    // Primary audio
    if (audioSource && audioSource.value) {
        constraints.audio = {
            deviceId: { exact: audioSource.value }
        };
    } else {
        constraints.audio = true;
    }

    // Video
    if (videoSource && videoSource.value) {
        const quality = videoQuality ? videoQuality.value : 'ideal';
        let w = 1280, h = 720;

        if (quality === 'max') { w = 1920; h = 1080; }
        if (quality === 'low') { w = 640; h = 360; }

        constraints.video = {
            deviceId: { exact: videoSource.value },
            width: { ideal: w },
            height: { ideal: h }
        };
    } else {
        constraints.video = true;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        localStream = stream;
        if (localVideo) {
            localVideo.srcObject = stream;
            await localVideo.play().catch(e => console.warn('Video play error:', e));
        }

        $('startStreamBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { 
        console.error(e); 
        alert("Camera access failed. Please check your browser permissions."); 
    }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];

    // Update Camera Button
    if ($('toggleCamBtn')) {
        $('toggleCamBtn').textContent = (vTrack && vTrack.enabled) ? 'Camera Off' : 'Camera On';
    }
    // Update Mic Button
    if ($('toggleMicBtn')) {
        $('toggleMicBtn').textContent = (aTrack && aTrack.enabled) ? 'Mute' : 'Unmute';
    }
}

function toggleCamera() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    if (!vTrack) return;
    vTrack.enabled = !vTrack.enabled;
    updateMediaButtons();
}

function toggleMic() {
    if (!localStream) return;
    const aTrack = localStream.getAudioTracks()[0];
    if (!aTrack) return;
    aTrack.enabled = !aTrack.enabled;
    updateMediaButtons();
}


// ======================================================
// 7. SCREEN SHARING
// ======================================================

async function startScreenShare() {
    try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 },
            audio: false
        });

        screenStream = displayStream;
        isScreenSharing = true;

        // Replace local video feed with screen
        if (localVideo) {
            localVideo.srcObject = displayStream;
            await localVideo.play().catch(e => console.warn('Screen play error:', e));
        }

        $('shareScreenBtn').textContent = 'Stop Share';
        $('shareScreenBtn').classList.add('danger');

        const screenTrack = displayStream.getVideoTracks()[0];
        if (screenTrack) {
            screenTrack.onended = () => {
                stopScreenShare();
            };
        }

    } catch (e) {
        console.error('Screen share error:', e);
        alert('Screen share failed or was cancelled.');
    }
}

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
    }
    screenStream = null;
    isScreenSharing = false;
    
    // Reset Button UI
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    
    // Switch back to Camera
    startLocalMedia();
}


// ======================================================
// 8. BROADCAST STREAMING (1-to-Many)
// ======================================================

if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        // Security check: Only host can stream
        if (!currentRoom || !iAmHost) {
            return alert("Host only functionality.");
        }
        
        if (isStreaming) {
            // --- STOP STREAMING ---
            isStreaming = false;
            $('startStreamBtn').textContent = "Start Stream";
            $('startStreamBtn').classList.remove('danger');
            
            // Disconnect all viewers (Cut the feed)
            Object.values(viewerPeers).forEach(pc => {
                try { pc.close(); } catch(e){}
            });
            viewerPeers = {};
            $('streamStatus').textContent = 'Offline';
            return;
        }

        // --- START STREAMING ---
        if (!localStream && !screenStream) {
            await startLocalMedia();
        }

        isStreaming = true;
        $('startStreamBtn').textContent = "Stop Stream";
        $('startStreamBtn').classList.add('danger');
        $('streamStatus').textContent = 'LIVE';

        latestUserList
          .filter(u => u.id !== myId)
          .forEach(u => connectViewer(u.id));
    });
}


// ======================================================
// 9. HOST ↔ VIEWER WEBRTC HANDSHAKE
// ======================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    // *** FORCE DATA CHANNEL FOR ARCADE ***
    const controlChannel = pc.createDataChannel("control");
    controlChannel.onopen = () => console.log(`Control channel open for ${targetId}`);

    pc.onicecandidate = e => { 
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); 
        }
    };

    // --- SEND MIXED CANVAS STREAM ---
    if (canvasStream) {
        canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    }

    // Add Audio (From the local stream)
    if(localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if(audioTrack) pc.addTrack(audioTrack, canvasStream || localStream);
    }
    
    // If a tool is loaded, send it to the new viewer immediately
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing tool to ${targetId}`);
        pushFileToPeer(pc, activeToolboxFile, null); 
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => { 
    if (viewerPeers[from]) {
        await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp)); 
    }
});

socket.on('webrtc-ice-candidate', async ({ from, candidate }) => { 
    if (viewerPeers[from]) {
        await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate)); 
    }
});


// ======================================================
// 10. P2P CALLS (SEPARATE FROM BROADCAST)
// ======================================================

const callPeers      = {};      // { socketId: { pc, stream } }
const remoteStreams  = {};      // { socketId: MediaStream }

function createCallPeer(targetId) {
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, stream: null };

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('call-ice', { targetId, candidate: e.candidate });
        }
    };

    pc.ontrack = e => {
        const stream = e.streams[0];
        callPeers[targetId].stream = stream;
        attachRemoteVideo(targetId, stream);
    };

    // Add local tracks (cam+mic) to the call
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    return pc;
}

function attachRemoteVideo(id, stream) {
    let videoEl = document.getElementById(`remoteVideo-${id}`);
    if (!videoEl) {
        videoEl = document.createElement('video');
        videoEl.id = `remoteVideo-${id}`;
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.className = 'remoteVideo remote-video-el';

        const container = document.createElement('div');
        container.className = 'video-container';
        container.appendChild(videoEl);

        const h2 = document.createElement('h2');
        h2.textContent = `Guest (${id.slice(0,4)})`;
        container.appendChild(h2);

        videoGrid.appendChild(container);
    }
    videoEl.srcObject = stream;
}

function removeRemoteVideo(id) {
    const el = document.getElementById(`remoteVideo-${id}`);
    if (el && el.parentElement) {
        el.parentElement.remove();
    }
}

socket.on('incoming-call', async ({ from, name, offer }) => {
    const accept = confirm(`Incoming call from ${name}. Accept?`);
    if (!accept) return;

    let pc = createCallPeer(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call-answer', { targetId: from, answer });
});

socket.on('call-answer', async ({ from, answer }) => {
    if (!callPeers[from]) return;
    const { pc } = callPeers[from];
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('call-ice', async ({ from, candidate }) => {
    if (!callPeers[from]) return;
    const { pc } = callPeers[from];
    if (candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
});

socket.on('call-end', ({ from }) => {
    endPeerCall(from, true);
});

function endPeerCall(id, isIncomingSignal) {
    if (callPeers[id]) { 
        try { callPeers[id].pc.close(); } catch(e){} 
    }
    delete callPeers[id];
    removeRemoteVideo(id);
    
    if (!isIncomingSignal) {
        socket.emit('call-end', { targetId: id });
    }
    renderUserList();
}


// ======================================================
// 11. SOCKET & ROOM LOGIC
// ======================================================

socket.on('connect', () => { 
    $('signalStatus').className = 'status-dot status-connected'; 
    $('signalStatus').textContent = 'Connected'; 
    myId = socket.id; 
});

socket.on('disconnect', () => { 
    $('signalStatus').className = 'status-dot status-disconnected'; 
    $('signalStatus').textContent = 'Disconnected'; 
});

// Join Button Logic
$('joinBtn').addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    const name = $('nameInput').value.trim() || 'Host';

    if (!room) {
        return alert('Please enter a room ID.');
    }

    currentRoom = room;
    userName = name;

    socket.connect();

    socket.emit('join-room', { room, name });
    $('joinBtn').disabled = true;
    $('leaveBtn').disabled = false;
    $('roomInput').disabled = true;
    $('nameInput').disabled = true;

    updateLink(room);
});

$('leaveBtn').addEventListener('click', () => {
    socket.disconnect();

    currentRoom = null;
    iAmHost = false;
    roomLocked = false;
    latestUserList = [];

    $('joinBtn').disabled = false;
    $('leaveBtn').disabled = true;
    $('roomInput').disabled = false;
    $('nameInput').disabled = false;

    $('roomInfo').textContent = '';
    $('userList').innerHTML = '';
    
    $('streamStatus').textContent = 'Offline';
    $('startStreamBtn').disabled = true;
    $('hostControls').style.display = 'none';
});

// Role update
socket.on('role', ({ isHost, streamTitle }) => {
    iAmHost = isHost;
    $('hostControls').style.display = isHost ? 'block' : 'none';
    $('headerTitle').textContent = isHost ? 'Rebel Stream (Host)' : 'Rebel Stream';

    if (streamTitle) {
        $('streamTitleInput').value = streamTitle;
    }
});

// User joined / left
socket.on('user-joined', ({ id, name }) => {
    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    if (iAmHost && isStreaming) {
        connectViewer(id);
    }
});

socket.on('user-left', ({ id }) => {
    if (viewerPeers[id]) { 
        viewerPeers[id].close(); 
        delete viewerPeers[id]; 
    }
    endPeerCall(id, true);
});

// Room Update
socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    roomLocked = locked;
    currentOwnerId = ownerId;
    latestUserList = users || [];

    $('lockRoomBtn').textContent = locked ? '🔒 Room Locked' : '🔓 Lock Room';
    $('lockRoomBtn').classList.toggle('danger', locked);

    if (streamTitle) {
        $('streamTitleInput').value = streamTitle;
    }

    renderUserList();
});

socket.on('room-error', (msg) => {
    alert(msg);
});

socket.on('kicked', () => {
    alert('You have been removed from this room by the host.');
    location.reload();
});


// ======================================================
// 12. CHAT LOGIC
// ======================================================

function appendChat(logEl, name, text, ts, isOwnerFlag, fromViewer) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = 'chat-line';

    const time = new Date(ts || Date.now()).toLocaleTimeString();
    const safeText = ('' + text).replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let prefix = fromViewer ? '[Viewer] ' : '';
    if (isOwnerFlag) prefix = '[Host] ';

    line.innerHTML = `
        <span style="color:#666; font-size:0.7rem; margin-right:6px;">${time}</span>
        <strong style="color:${isOwnerFlag ? '#4af3a3' : '#fff'}">${prefix}${name}</strong>:
        <span>${safeText}</span>
    `;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

socket.on('public-chat', ({ name, text, ts, isOwner, fromViewer }) => {
    appendChat($('chatLogPublic'), name, text, ts, isOwner, fromViewer);
});

socket.on('private-chat', ({ name, text, ts }) => {
    appendChat($('chatLogPrivate'), name, text, ts, false, false);
});

$('btnSendPublic').addEventListener('click', () => {
    const input = $('inputPublic');
    const text = input.value.trim();
    if (!text || !currentRoom) return;

    socket.emit('public-chat', {
        room: currentRoom,
        name: userName,
        text
    });
    input.value = '';
});

$('inputPublic').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnSendPublic').click();
});

$('btnSendPrivate').addEventListener('click', () => {
    const input = $('inputPrivate');
    const text = input.value.trim();
    if (!text || !currentRoom) return;

    socket.emit('private-chat', {
        room: currentRoom,
        name: userName,
        text
    });
    input.value = '';
});

$('inputPrivate').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnSendPrivate').click();
});

function setupEmojiStrips() {
    const stripPublic = $('emojiStripPublic');
    const stripPrivate = $('emojiStripPrivate');

    if (stripPublic) {
        stripPublic.addEventListener('click', (e) => {
            if (e.target.classList.contains('emoji')) {
                $('inputPublic').value += e.target.textContent;
                $('inputPublic').focus();
            }
        });
    }

    if (stripPrivate) {
        stripPrivate.addEventListener('click', (e) => {
            if (e.target.classList.contains('emoji')) {
                $('inputPrivate').value += e.target.textContent;
                $('inputPrivate').focus();
            }
        });
    }
}


// ======================================================
// 13. FILE UPLOAD (10MB)
// ======================================================

let selectedFile = null;

function setupFileUpload() {
    const fileInput = $('fileInput');
    const sendBtn = $('sendFileBtn');

    fileInput.addEventListener('change', () => {
        selectedFile = fileInput.files[0] || null;
        $('fileNameLabel').textContent = selectedFile ? selectedFile.name : 'No file selected';
        sendBtn.disabled = !selectedFile;
    });

    sendBtn.addEventListener('click', async () => {
        if (!selectedFile || !currentRoom) return;

        if (selectedFile.size > 10 * 1024 * 1024) {
            alert('File too large. Max 10MB.');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            const buffer = reader.result;
            socket.emit('file-share', {
                room: currentRoom,
                name: userName,
                fileName: selectedFile.name,
                fileType: selectedFile.type || 'application/octet-stream',
                fileData: buffer
            });
            appendFileLog(userName, selectedFile.name, buffer);
        };
        reader.readAsArrayBuffer(selectedFile);
    });
}

socket.on('file-share', ({ name, fileName, fileType, fileData }) => {
    appendFileLog(name, fileName, fileData);
});

function appendFileLog(name, fileName, fileData) {
    const log = $('fileLog');
    if (!log) return;

    const url = URL.createObjectURL(new Blob([fileData]));
    const row = document.createElement('div');
    row.className = 'file-row';

    row.innerHTML = `
        <span class="file-label">${name}</span>
        <span class="file-name">${fileName}</span>
        <a href="${url}" download="${fileName}" class="btn small">Download</a>
    `;
    log.appendChild(row);
}


// ======================================================
// 14. USER LIST & ROOM CONTROLS
// ======================================================

function renderUserList() {
    const list = $('userList');
    list.innerHTML = '';

    latestUserList.forEach(u => {
        const isOwner = (u.id === currentOwnerId);
        const isMe    = (u.id === myId);

        const item = document.createElement('div');
        item.className = 'user-item';

        let label = `${u.name || 'Unknown'} (${u.id.slice(0,4)})`;
        if (isOwner) label = `👑 ${label}`;
        if (isMe)    label = `${label} [You]`;

        const left = document.createElement('span');
        left.textContent = label;

        const right = document.createElement('div');

        // Start call button (but not with self)
        if (!isMe) {
            const callBtn = document.createElement('button');
            callBtn.textContent = 'Call';
            callBtn.className = 'action-btn';
            callBtn.onclick = () => startCall(u.id);
            right.appendChild(callBtn);
        }

        // Host-only Kick + Promote
        if (iAmHost && !isMe) {
            const kickBtn = document.createElement('button');
            kickBtn.textContent = 'Kick';
            kickBtn.className = 'action-btn kick';
            kickBtn.onclick = () => {
                if (confirm(`Kick ${u.name}?`)) {
                    socket.emit('kick-user', u.id);
                }
            };
            right.appendChild(kickBtn);

            const promoteBtn = document.createElement('button');
            promoteBtn.textContent = 'Host';
            promoteBtn.className = 'action-btn';
            promoteBtn.onclick = () => {
                if (confirm(`Make ${u.name} the host?`)) {
                    socket.emit('promote-to-host', u.id);
                }
            };
            right.appendChild(promoteBtn);
        }

        item.appendChild(left);
        item.appendChild(right);
        list.appendChild(item);
    });
}

function startCall(targetId) {
    const pc = createCallPeer(targetId);
    pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socket.emit('call-offer', { targetId, offer });
    });
}

// Lock room
$('lockRoomBtn').addEventListener('click', () => {
    if (!iAmHost) return;
    roomLocked = !roomLocked;
    socket.emit('lock-room', roomLocked);
});

// Update Stream Title
$('updateTitleBtn').addEventListener('click', () => {
    if (!iAmHost || !currentRoom) return;
    const title = $('streamTitleInput').value.trim() || 'Untitled Stream';
    socket.emit('update-stream-title', title);
});


// ======================================================
// 15. VIP / PRIVATE ROOM MODE
// ======================================================

function setupVipPrivateMode() {
    const toggleBtn = $('togglePrivateBtn');
    const addGuestBtn = $('addGuestBtn');
    const guestNameInput = $('guestNameInput');
    const guestPanel = $('guestListPanel');

    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', () => {
        isPrivateMode = !isPrivateMode;
        toggleBtn.textContent = isPrivateMode ? 'ON' : 'OFF';
        guestPanel.style.display = isPrivateMode ? 'block' : 'none';
    });

    addGuestBtn.addEventListener('click', () => {
        const name = guestNameInput.value.trim();
        if (!name) return;
        allowedGuests.push(name);
        guestNameInput.value = '';
        renderGuestList();
    });
}

function renderGuestList() {
    const display = $('guestListDisplay');
    display.innerHTML = '';
    allowedGuests.forEach(name => {
        const tag = document.createElement('span');
        tag.style.cssText = "background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem;";
        tag.textContent = name;
        display.appendChild(tag);
    });
}


// ======================================================
// 16. QR CODE & VIEWER LINK
// ======================================================

function updateLink(slugOrRoom) {
    const roomSlug = slugOrRoom || currentRoom;
    if (!roomSlug) return;

    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;

    const link = url.toString();
    const input = $('streamLinkInput');
    if (input) {
        input.value = link;
    }

    if (window.QRCode) {
        const qrEl = $('qrcode');
        qrEl.innerHTML = '';
        new QRCode(qrEl, {
            text: link,
            width: 96,
            height: 96
        });
    }
}

function setupQrCode() {
    $('openStreamBtn').addEventListener('click', () => {
        const link = $('streamLinkInput').value;
        if (link) window.open(link, '_blank');
    });

    $('updateSlugBtn').addEventListener('click', () => {
        const slugInput = $('slugInput').value.trim();
        if (!slugInput) {
            updateLink(currentRoom);
            return;
        }
        const safeSlug = slugInput.replace(/[^a-zA-Z0-9-_]/g, '').toLowerCase();
        updateLink(safeSlug);
    });
}


// ======================================================
// 17. STREAM PREVIEW MONITOR
// ======================================================

function wireButtons() {
    // Camera / mic / settings
    $('toggleCamBtn').addEventListener('click', toggleCamera);
    $('toggleMicBtn').addEventListener('click', toggleMic);
    $('settingsBtn').addEventListener('click', () => {
        $('settingsPanel').style.display = 'block';
    });
    $('closeSettingsBtn').addEventListener('click', () => {
        $('settingsPanel').style.display = 'none';
    });

    // Screen share
    $('shareScreenBtn').addEventListener('click', () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            startScreenShare();
        }
    });

    // Preview monitor
    $('previewStreamBtn').addEventListener('click', () => {
        if (!canvasStream) {
            alert('Stream not ready yet.');
            return;
        }
        const previewTrack = canvasStream.getVideoTracks()[0];
        if (!previewTrack) {
            alert('No mixer video track.');
            return;
        }
        previewVideo.srcObject = canvasStream;
        previewModal.classList.add('active');
    });

    $('closePreviewBtn').addEventListener('click', () => {
        previewModal.classList.remove('active');
        previewVideo.srcObject = null;
    });
}


// ======================================================
// 18. ARCADE TOOLBOX SETUP
// ======================================================

function setupArcade() {
    const arcadeInput = $('arcadeInput');
    const arcadeStatus = $('arcadeStatus');

    if (!arcadeInput || !arcadeStatus) return;

    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if (!file) return;

        activeToolboxFile = file;
        arcadeStatus.textContent = `[Loaded]: ${file.name}`;
    });
}


// ======================================================
// 19. EXTRA WIRING FOR HOST-ONLY BOUNCER
// ======================================================

socket.on('user-joined', ({ id, name }) => {

    // VIP BOUNCER CHECK
    if (iAmHost && isPrivateMode) {
        const isAllowed = allowedGuests.some(g => g.toLowerCase() === name.toLowerCase());
        if (!isAllowed) {
            console.log(`[Bouncer] Kicking ${name}`);
            socket.emit('kick-user', id);
            return;
        }
    }

    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    
    // If I'm live, connect them as viewer right away
    if (iAmHost && isStreaming) {
        connectViewer(id);
    }
});


// (Note: We already have the 'user-left' handler above)


// ======================================================
// 20. EXPORT CLEAR OVERLAY FOR GLOBAL USE
// ======================================================

window.clearOverlay = clearOverlay;
