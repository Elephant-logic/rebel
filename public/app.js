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

        // 2. Read the file into memory
        const buffer = await file.arrayBuffer();
        let offset = 0;

        // 3. Send Loop (Chunks)
        const sendLoop = () => {
            // Check if the network buffer is full. If so, wait.
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }

            // If the channel closes mid-transfer, stop.
            if (channel.readyState !== 'open') {
                console.log('[Arcade] Channel closed mid-transfer.');
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
                setTimeout(() => {
                    channel.close();
                }, 1000);
            }
        };
        sendLoop();
    };

    channel.onerror = (err) => {
        console.error('[Arcade] DataChannel error:', err);
    };
}

// ======================================================
// 2. MAIN APP SETUP & GLOBAL VARIABLES
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

// Private room logic
let isPrivateMode = false;
let allowedGuests = [];
let mutedUsers = new Set();

// Media & WebRTC
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false;

// Toolbox / Arcade
let activeToolboxFile = null;

// Audio mixing
let audioContext = null;
let audioDestination = null;

// Canvas-based mixer
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 

let mixerLayout = 'SOLO';
let activeGuestId = null;

// Overlay engine
let overlayActive = false;
let overlayImage = new Image();
let currentRawHTML = "";

// Peer maps
const viewerPeers = {}; // { socketId: RTCPeerConnection } - viewers of the stream
const callPeers = {};   // { socketId: { pc, name } } - direct call peers

// ICE / TURN configuration
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ======================================================
// 3. CANVAS MIXER ENGINE (The "Broadcast" Logic)
// ======================================================

/**
 * drawMixer:
 * - Renders the current layout (SOLO, GUEST, SPLIT, PIP, PIP_INVERTED)
 * - Draws local & remote video(s) into a 1920x1080 canvas
 * - Optionally draws HTML overlay (if overlayActive)
 */
function drawMixer() {
    if (!ctx) return;
    
    // Clear background
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
            ctx.fillStyle = '#333'; 
            ctx.fillRect(0,0,canvas.width, canvas.height);
            ctx.fillStyle = '#fff'; 
            ctx.font = "60px Arial"; 
            ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest Signal...", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        const participants = [];
        if (myVideo && myVideo.readyState === 4) participants.push(myVideo);
        
        Object.keys(callPeers).forEach(id => {
            const el = document.getElementById(`vid-${id}`);
            if (el) {
                const v = el.querySelector('video');
                if (v && v.readyState === 4) {
                    participants.push(v);
                }
            }
        });

        const count = participants.length;
        const slotW = canvas.width / (count || 1);
        const vidH = slotW / (16/9);
        const yOffset = (1080 - vidH) / 2;

        participants.forEach((vid, i) => {
            ctx.drawImage(vid, i * slotW, yOffset, slotW, vidH);
            if (i > 0) {
                ctx.strokeStyle = '#222';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(i * slotW, 0);
                ctx.lineTo(i * slotW, 1080);
                ctx.stroke();
            }
        });
    }
    else if (mixerLayout === 'PIP') {
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
        
        if (guestVideo && guestVideo.readyState === 4) {
            const pipW = 480, pipH = 270, padding = 30;
            const x = canvas.width - pipW - padding;
            const y = canvas.height - pipH - padding;
            ctx.strokeStyle = "#4af3a3"; 
            ctx.lineWidth = 5;
            ctx.strokeRect(x, y, pipW, pipH);
            ctx.drawImage(guestVideo, x, y, pipW, pipH);
        }
    }
    else if (mixerLayout === 'PIP_INVERTED') {
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = '#111'; 
            ctx.fillRect(0,0,canvas.width, canvas.height);
        }
        
        if (myVideo && myVideo.readyState === 4) {
            const pipW = 480, pipH = 270, padding = 30;
            const x = canvas.width - pipW - padding;
            const y = canvas.height - pipH - padding;
            ctx.strokeStyle = "#4af3a3"; 
            ctx.lineWidth = 5;
            ctx.strokeRect(x, y, pipW, pipH);
            ctx.drawImage(myVideo, x, y, pipW, pipH);
        }
    }

    // Draw overlay on top
    if (overlayActive && overlayImage.complete) {
        try {
            ctx.drawImage(overlayImage, 0, 0, canvas.width, canvas.height);
        } catch (e) {
            console.error('[Overlay] drawImage failed', e);
        }
    }

    requestAnimationFrame(drawMixer);
}

// Start mixer
canvasStream = canvas.captureStream(30); // 30 fps
drawMixer();

// --- STREAM PREVIEW POPUP (HOST MONITOR) ---
const previewModal = $('streamPreviewModal');
const previewVideo = $('streamPreviewVideo');
const previewBtn = $('previewStreamBtn');
const closePreviewBtn = $('closePreviewBtn');

function openStreamPreview() {
    if (!canvasStream) {
        alert("Stream engine not initialized.");
        return;
    }
    if (previewVideo) {
        previewVideo.srcObject = canvasStream; 
        previewVideo.muted = true;
        previewVideo.play().catch(() => {});
    }
    if (previewModal) {
        previewModal.classList.add('active');
    }
}

function closeStreamPreview() {
    if (previewModal) {
        previewModal.classList.remove('active');
    }
    if (previewVideo) {
        previewVideo.srcObject = null;
    }
}

if (previewBtn) previewBtn.addEventListener('click', openStreamPreview);
if (closePreviewBtn) closePreviewBtn.addEventListener('click', closeStreamPreview);
if (previewModal) {
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) closeStreamPreview();
    });
}

// --- HTML LAYOUT ENGINE ---
function renderHTMLLayout(htmlString) {
    if (!htmlString) return;
    currentRawHTML = htmlString;
    
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
            <foreignObject width="100%" height="100%">
                <div xmlns="http://www.w3.org/1999/xhtml" class="layout-${mixerLayout}" style="width:100%; height:100%; margin:0; padding:0;">
                    ${htmlString}
                </div>
            </foreignObject>
        </svg>`;
    
    overlayImage.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    overlayActive = true;
}

// Expose some mixer functions globally
window.setMixerLayout = (mode) => {
    mixerLayout = mode;

    const mixerButtons = document.querySelectorAll('.mixer-btn');
    mixerButtons.forEach(b => {
        b.classList.remove('active');
        if (b.getAttribute('onclick') && b.getAttribute('onclick').includes(`'${mode}'`)) {
            b.classList.add('active');
        }
    });

    if (overlayActive && currentRawHTML) {
        renderHTMLLayout(currentRawHTML);
    }
};

window.setActiveGuest = (id) => {
    activeGuestId = id;
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

if(tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if(tabs.room) tabs.room.onclick = () => switchTab('room');
if(tabs.files) tabs.files.onclick = () => switchTab('files');
if(tabs.users) tabs.users.onclick = () => switchTab('users');

// ======================================================
// 5. DEVICE SETTINGS
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

if ($('closeSettingsBtn')) {
    $('closeSettingsBtn').addEventListener('click', () => {
        settingsPanel.style.display = 'none';
    });
}

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

        // Pre-select current track devices if we already have a stream
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at && at.getSettings().deviceId) {
                audioSource.value = at.getSettings().deviceId;
            }
            if (vt && vt.getSettings().deviceId) {
                videoSource.value = vt.getSettings().deviceId;
            }
        }
    } catch (e) { 
        console.error('getDevices error:', e); 
    }
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

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    try {
        const quality = videoQuality ? videoQuality.value : 'ideal';
        let widthConstraint, heightConstraint;

        if (quality === 'max') {
            widthConstraint = { ideal: 1920 };
            heightConstraint = { ideal: 1080 };
        } else if (quality === 'low') {
            widthConstraint = { ideal: 640 };
            heightConstraint = { ideal: 360 };
        } else {
            widthConstraint = { ideal: 1280 };
            heightConstraint = { ideal: 720 };
        }

        const constraints = {
            audio: audioSource.value 
                ? { deviceId: { exact: audioSource.value } }
                : true,
            video: videoSource.value 
                ? { deviceId: { exact: videoSource.value }, width: widthConstraint, height: heightConstraint }
                : { width: widthConstraint, height: heightConstraint }
        };

        const mainStream = await navigator.mediaDevices.getUserMedia(constraints);

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

        const localVideo = $('localVideo');
        localVideo.srcObject = localStream;
        localVideo.muted = true;

        const mixedVideoTrack = canvasStream.getVideoTracks()[0];

        // Update all viewer PCs (broadcast)
        const updateViewerPC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();

            const vSender = senders.find(s => s.track && s.track.kind === 'video');
            if (vSender) {
                vSender.replaceTrack(mixedVideoTrack);
            }

            const aSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (aSender) {
                aSender.replaceTrack(finalAudioTrack);
            }
        };

        Object.values(viewerPeers).forEach(updateViewerPC);

        // Update call peers (camera for calls remains the original camera feed)
        Object.values(callPeers).forEach(p => {
            const senders = p.pc.getSenders();
            const vSender = senders.find(s => s.track && s.track.kind === 'video');
            if(vSender) vSender.replaceTrack(mainStream.getVideoTracks()[0]);
            const aSender = senders.find(s => s.track && s.track.kind === 'audio');
            if(aSender) aSender.replaceTrack(finalAudioTrack);
        });

        const hangupBtn = $('hangupBtn');
        if (hangupBtn) hangupBtn.disabled = false;

        updateMediaButtons();
    } catch (e) {
        console.error('startLocalMedia error:', e);
        alert("Camera/mic access failed. Check permissions.");
    }
}

function updateMediaButtons() {
    if (!localStream) return;

    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];

    const camBtn = $('toggleCamBtn');
    const micBtn = $('toggleMicBtn');

    if (camBtn) {
        const isCamOn = !!(vTrack && vTrack.enabled);
        camBtn.textContent = isCamOn ? 'Camera On' : 'Camera Off';
        camBtn.classList.toggle('danger', !isCamOn);
    }

    if (micBtn) {
        const isMicOn = !!(aTrack && aTrack.enabled);
        micBtn.textContent = isMicOn ? 'Mute' : 'Unmute';
        micBtn.classList.toggle('danger', !isMicOn);
    }
}

if ($('toggleMicBtn')) {
    $('toggleMicBtn').onclick = () => {
        if (!localStream) return;
        const t = localStream.getAudioTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        updateMediaButtons();
    };
}

if ($('toggleCamBtn')) {
    $('toggleCamBtn').onclick = () => {
        if (!localStream) return;
        const t = localStream.getVideoTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        updateMediaButtons();
    };
}

// ======================================================
// 7. SCREEN SHARING
// ======================================================

if ($('shareScreenBtn')) {
    $('shareScreenBtn').onclick = async () => {
        if (isScreenSharing) {
            stopScreenShare();
            return;
        }

        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            isScreenSharing = true;

            const shareBtn = $('shareScreenBtn');
            shareBtn.textContent = 'Stop Screen';
            shareBtn.classList.add('danger');

            const localVideo = $('localVideo');
            localVideo.srcObject = screenStream;

            const st = screenStream.getVideoTracks()[0];
            const sa = screenStream.getAudioTracks()[0];

            Object.values(callPeers).forEach(p => {
                p.pc.getSenders().forEach(s => {
                    if(s.track && s.track.kind === 'video') s.replaceTrack(st);
                    if(sa && s.track && s.track.kind === 'audio') s.replaceTrack(sa);
                });
            });

            st.onended = stopScreenShare;
        } catch(e) { 
            console.error('shareScreen error:', e); 
        }
    };
}

function stopScreenShare() {
    if (!isScreenSharing) return;

    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
    }

    screenStream = null;
    isScreenSharing = false;

    const shareBtn = $('shareScreenBtn');
    if (shareBtn) {
        shareBtn.textContent = 'Share Screen';
        shareBtn.classList.remove('danger');
    }

    startLocalMedia();
}

// ======================================================
// 8. BROADCAST STREAMING (HOST → VIEWERS)
// ======================================================

async function handleStartStream() {
    if (!currentRoom || !iAmHost) return;

    if (!localStream) {
        await startLocalMedia();
    }

    isStreaming = true;

    const btn = $('startStreamBtn');
    if (btn) {
        btn.textContent = "Stop Stream";
        btn.classList.add('danger');
    }

    latestUserList.forEach(u => {
        if (u.id !== myId) {
            connectViewer(u.id);
        }
    });
}

if ($('startStreamBtn')) {
    $('startStreamBtn').onclick = async () => {
        if (!currentRoom || !iAmHost) {
            alert("Only the host can start the stream.");
            return;
        }

        if (isStreaming) {
            isStreaming = false;

            const btn = $('startStreamBtn');
            if (btn) {
                btn.textContent = "Start Stream";
                btn.classList.remove('danger');
            }

            // Close all viewer peer connections
            Object.values(viewerPeers).forEach(pc => {
                try {
                    pc.close();
                } catch(e){}
            });
            for (const k in viewerPeers) {
                delete viewerPeers[k];
            }
        } else {
            await handleStartStream();
        }
    };
}

// ======================================================
// 9. P2P CALLING (1-to-1)
// ======================================================

if ($('hangupBtn')) {
    $('hangupBtn').onclick = () => {
        Object.keys(callPeers).forEach(id => endPeerCall(id));
    };
}

socket.on('ring-alert', async ({ from, fromId }) => {
    const accept = confirm(`Incoming call from ${from}. Accept?`);
    if (accept) {
        await callPeer(fromId);
    }
});

async function callPeer(targetId) {
    if (!localStream) {
        await startLocalMedia();
    }

    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, name: "Peer" };

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('call-ice', { targetId, candidate: e.candidate });
        }
    };

    pc.ontrack = e => {
        addRemoteVideo(targetId, e.streams[0]);
    };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('call-offer', { targetId, offer });
    renderUserList();
}

socket.on('incoming-call', async ({ from, name, offer }) => {
    if (!localStream) {
        await startLocalMedia();
    }

    const pc = new RTCPeerConnection(iceConfig);
    callPeers[from] = { pc, name };

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('call-ice', { targetId: from, candidate: e.candidate });
        }
    };

    pc.ontrack = e => {
        addRemoteVideo(from, e.streams[0]);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('call-answer', { targetId: from, answer });
    renderUserList();
});

socket.on('call-answer', async ({ from, answer }) => {
    if (!callPeers[from]) return;
    await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('call-ice', ({ from, candidate }) => {
    if (!callPeers[from]) return;
    callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('call-end', ({ from }) => {
    endPeerCall(from, true);
});

function endPeerCall(id, isIncomingSignal) {
    if (callPeers[id]) {
        try {
            callPeers[id].pc.close();
        } catch(e){}
        delete callPeers[id];
        removeRemoteVideo(id);
    }

    if (!isIncomingSignal) {
        socket.emit('call-end', { targetId: id });
    }

    renderUserList();
}

// ======================================================
// 10. VIEWER CONNECTION & ARCADE PUSH
// ======================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;

    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;

    const controlChannel = pc.createDataChannel("control");
    controlChannel.onopen = () => {
        console.log('[Viewer-Control] DataChannel opened for', targetId);
    };
    controlChannel.onerror = err => {
        console.error('[Viewer-Control] DataChannel error:', err);
    };

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate });
        }
    };

    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));

    if(localStream) {
        const at = localStream.getAudioTracks()[0];
        if(at) pc.addTrack(at, canvasStream);
    }

    if (activeToolboxFile) {
        pushFileToPeer(pc, activeToolboxFile, null);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('webrtc-offer', { targetId, sdp: offer });
}

socket.on('webrtc-answer', async ({ from, sdp }) => {
    if (!viewerPeers[from]) return;
    await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
    if (!viewerPeers[from]) return;
    await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate));
});

// ======================================================
// 11. SOCKET & ROOM LOGIC
// ======================================================

socket.on('connect', () => {
    const sig = $('signalStatus');
    if (sig) {
        sig.className = 'status-dot status-connected';
        sig.textContent = 'Connected';
    }
    myId = socket.id;
});

socket.on('disconnect', () => {
    const sig = $('signalStatus');
    if (sig) {
        sig.className = 'status-dot status-disconnected';
        sig.textContent = 'Disconnected';
    }
});

if ($('joinBtn')) {
    $('joinBtn').onclick = () => {
        const roomInput = $('roomInput');
        const nameInput = $('nameInput');
        if (!roomInput) return;

        const room = roomInput.value.trim();
        if (!room) {
            alert('Enter a room ID.');
            return;
        }

        currentRoom = room;
        userName = (nameInput && nameInput.value.trim()) || 'Host';

        socket.connect();
        socket.emit('join-room', { room, name: userName });

        $('joinBtn').disabled = true;
        if ($('leaveBtn')) $('leaveBtn').disabled = false;

        updateLink(room);
        startLocalMedia();
    };
}

if ($('leaveBtn')) {
    $('leaveBtn').onclick = () => {
        window.location.reload();
    };
}

function generateQR(url) {
    const container = $('qrcode');
    if (!container || typeof QRCode === 'undefined') return;

    container.innerHTML = "";
    new QRCode(container, {
        text: url,
        width: 128,
        height: 128,
        colorDark : "#4af3a3",
        colorLight : "#101524"
    });
}

function updateLink(roomSlug) {
    try {
        const url = new URL(window.location.href);
        const basePath = url.pathname.replace('index.html', '');
        url.pathname = basePath + 'view.html';
        url.search = `?room=${encodeURIComponent(roomSlug)}`;

        const finalUrl = url.toString();

        if ($('streamLinkInput')) {
            $('streamLinkInput').value = finalUrl;
        }

        generateQR(finalUrl);
    } catch (e) {
        console.error('updateLink error:', e);
    }
}

socket.on('user-joined', ({ id, name }) => {
    if (iAmHost && isPrivateMode) {
        const allowed = allowedGuests.some(g => g.toLowerCase() === name.toLowerCase());
        if (!allowed) { 
            socket.emit('kick-user', id); 
            return; 
        }
    }

    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());

    if (iAmHost && isStreaming) {
        connectViewer(id);
    }
});

socket.on('user-left', ({ id }) => {
    if (viewerPeers[id]) {
        try { viewerPeers[id].close(); } catch(e){}
        delete viewerPeers[id];
    }
    endPeerCall(id, true);
});

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users || [];
    currentOwnerId = ownerId;

    const streamTitleInput = $('streamTitleInput');
    if (streamTitle && streamTitleInput) {
        streamTitleInput.value = streamTitle;
        updateLink($('roomInput').value || currentRoom);
    }

    const lockRoomBtn = $('lockRoomBtn');
    if (lockRoomBtn) {
        lockRoomBtn.textContent = locked ? 'Unlock Room' : 'Lock Room';
        lockRoomBtn.onclick = () => {
            if(iAmHost) {
                socket.emit('lock-room', !locked);
            }
        };
    }

    renderUserList();
});

socket.on('role', async ({ isHost }) => {
    wasHost = iAmHost;
    iAmHost = isHost;

    const localContainer = $('localContainer');
    if (localContainer) {
        const header = localContainer.querySelector('h2');
        if (header) {
            header.textContent = isHost ? 'You (Host)' : 'You';
        }
    }

    const hostControls = $('hostControls');
    if (hostControls) {
        hostControls.style.display = isHost ? 'block' : 'none';
    }

    renderUserList();
});

// ======================================================
// 12. HOST CONTROLS
// ======================================================

if ($('updateTitleBtn')) {
    $('updateTitleBtn').onclick = () => {
        const input = $('streamTitleInput');
        if (!input) return;

        const t = input.value.trim();
        if (!t) return;

        socket.emit('update-stream-title', t);
    };
}

if ($('streamTitleInput')) {
    $('streamTitleInput').onkeydown = (e) => {
        if(e.key === 'Enter') {
            const t = e.target.value.trim();
            if(t) socket.emit('update-stream-title', t);
        }
    };
}

if ($('updateSlugBtn')) {
    $('updateSlugBtn').onclick = () => {
        const s = $('slugInput').value.trim();
        if (s) updateLink(s);
    };
}

if ($('slugInput')) {
    $('slugInput').onkeydown = (e) => {
        if(e.key === 'Enter') {
            const s = e.target.value.trim();
            if(s) updateLink(s);
        }
    };
}

if ($('togglePrivateBtn')) {
    $('togglePrivateBtn').onclick = () => {
        isPrivateMode = !isPrivateMode;

        const btn = $('togglePrivateBtn');
        btn.textContent = isPrivateMode ? "ON" : "OFF";
        btn.className = isPrivateMode ? "btn small danger" : "btn small secondary";

        const panel = $('guestListPanel');
        if (panel) {
            panel.style.display = isPrivateMode ? "block" : "none";
        }

        if (isPrivateMode) {
            latestUserList.forEach(u => {
                if (u.id !== myId && !allowedGuests.some(g => g.toLowerCase() === u.name.toLowerCase())) {
                    socket.emit('kick-user', u.id);
                }
            });
        }
    };
}

if ($('addGuestBtn')) {
    $('addGuestBtn').onclick = () => {
        const inp = $('guestNameInput');
        if (!inp) return;

        const n = inp.value.trim();
        if (n && !allowedGuests.includes(n)) {
            allowedGuests.push(n);
            renderGuestList();
            inp.value = '';
        }
    };
}

function renderGuestList() {
    const d = $('guestListDisplay');
    if (!d) return;
    d.innerHTML = '';

    allowedGuests.forEach(name => {
        const t = document.createElement('span');
        t.style.cssText = "background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem; margin:2px;";
        t.textContent = name;
        d.appendChild(t);
    });
}

// ======================================================
// 13. CHAT SYSTEM
// ======================================================

function appendChat(log, name, text, ts) {
    if (!log) return;

    const d = document.createElement('div'); 
    d.className = 'chat-line';

    const s = document.createElement('strong'); 
    s.textContent = name;

    const t = document.createElement('small'); 
    t.textContent = new Date(ts).toLocaleTimeString();

    d.appendChild(s); 
    d.appendChild(document.createTextNode(' ')); 
    d.appendChild(t); 
    d.appendChild(document.createTextNode(`: ${text}`));

    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

function sendPublic() {
    const i = $('inputPublic');
    if (!i) return;
    const t = i.value.trim();
    if(!t || !currentRoom) return;

    socket.emit('public-chat', { room: currentRoom, name: userName, text: t });
    i.value = '';
}

if ($('btnSendPublic')) {
    $('btnSendPublic').onclick = sendPublic;
}

if ($('inputPublic')) {
    $('inputPublic').onkeydown = (e) => {
        if(e.key === 'Enter') sendPublic();
    };
}

function sendPrivate() {
    const i = $('inputPrivate');
    if (!i) return;
    const t = i.value.trim();
    if(!t || !currentRoom) return;

    socket.emit('private-chat', { room: currentRoom, name: userName, text: t });
    i.value = '';
}

if ($('btnSendPrivate')) {
    $('btnSendPrivate').onclick = sendPrivate;
}

if ($('inputPrivate')) {
    $('inputPrivate').onkeydown = (e) => {
        if(e.key === 'Enter') sendPrivate();
    };
}

socket.on('public-chat', d => {
    if (mutedUsers.has(d.name)) return;
    appendChat($('chatLogPublic'), d.name, d.text, d.ts);

    if(tabs.stream && !tabs.stream.classList.contains('active')) {
        tabs.stream.classList.add('has-new');
    }
});

socket.on('private-chat', d => {
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts);

    if(tabs.room && !tabs.room.classList.contains('active')) {
        tabs.room.classList.add('has-new');
    }
});

if ($('emojiStripPublic')) {
    $('emojiStripPublic').onclick = e => {
        if(e.target.classList.contains('emoji')) {
            $('inputPublic').value += e.target.textContent;
        }
    };
}

if ($('emojiStripPrivate')) {
    $('emojiStripPrivate').onclick = e => {
        if(e.target.classList.contains('emoji')) {
            $('inputPrivate').value += e.target.textContent;
        }
    };
}

// ======================================================
// 14. FILE SHARING (TAB)
// ======================================================

const fileInput = $('fileInput');

if (fileInput) {
    fileInput.onchange = () => {
        if(fileInput.files.length) {
            $('fileNameLabel').textContent = fileInput.files[0].name;
            $('sendFileBtn').disabled = false;
        }
    };
}

if ($('sendFileBtn')) {
    $('sendFileBtn').onclick = () => {
        const f = fileInput.files[0];
        if(!f || !currentRoom) return;

        if (f.size > 10 * 1024 * 1024) { 
            alert("File too large (Limit: 10MB). Use 'Arcade' for bigger tools/games."); 
            return; 
        }

        const r = new FileReader();
        r.onload = () => {
            socket.emit('file-share', { 
                room: currentRoom, 
                name: userName, 
                fileName: f.name, 
                fileData: r.result 
            });

            fileInput.value = '';
            $('fileNameLabel').textContent = 'No file selected';
            $('sendFileBtn').disabled = true;
        };
        r.readAsDataURL(f);
    };
}

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

    if ($('fileLog')) {
        $('fileLog').appendChild(div);
    }

    if(tabs.files && !tabs.files.classList.contains('active')) {
        tabs.files.classList.add('has-new');
    }
});

// ======================================================
// 15. ARCADE & HTML OVERLAY INPUTS
// ======================================================

const arcadeInput = $('arcadeInput');

if (arcadeInput) {
    arcadeInput.onchange = () => {
        const f = arcadeInput.files[0]; 
        if(!f) return;

        activeToolboxFile = f;
        $('arcadeStatus').textContent = `Active: ${f.name}`;

        Object.values(viewerPeers).forEach(pc => {
            pushFileToPeer(pc, f);
        });
    };
}

const htmlOverlayInput = $('htmlOverlayInput');

if (htmlOverlayInput) {
    htmlOverlayInput.onchange = (e) => {
        const f = e.target.files[0]; 
        if (!f) return;

        const r = new FileReader();
        r.onload = (ev) => {
            renderHTMLLayout(ev.target.result);
            const overlayStatus = $('overlayStatus');
            if (overlayStatus) {
                overlayStatus.textContent = f.name;
            }
        };
        r.readAsText(f);
    };
}

window.clearOverlay = () => {
    overlayActive = false; 
    overlayImage = new Image(); 
    if($('overlayStatus')) {
        $('overlayStatus').textContent = "[Empty]";
    }
};

// ======================================================
// 16. USER LIST & MIXER SELECTION
// ======================================================

function renderUserList() {
    const list = $('userList'); 
    if (!list) return; 

    list.innerHTML = '';

    latestUserList.forEach(u => {
        if (u.id === myId) return;

        const div = document.createElement('div'); 
        div.className = 'user-item';

        const nameSpan = document.createElement('span'); 
        if (u.id === currentOwnerId) nameSpan.textContent = '👑 ';
        nameSpan.textContent += u.name;

        const actionsDiv = document.createElement('div'); 
        actionsDiv.className = 'user-actions';

        const isCalling = !!callPeers[u.id];

        if (iAmHost) {
            const mBtn = document.createElement('button'); 
            mBtn.className = 'action-btn'; 
            mBtn.textContent = mutedUsers.has(u.name) ? 'Unmute' : 'Mute';
            mBtn.onclick = () => { 
                if(mutedUsers.has(u.name)) mutedUsers.delete(u.name); 
                else mutedUsers.add(u.name); 
                renderUserList(); 
            };
            actionsDiv.appendChild(mBtn);
        }

        const callBtn = document.createElement('button'); 
        callBtn.className = 'action-btn';

        if (isCalling) { 
            callBtn.textContent = 'End'; 
            callBtn.style.color = 'var(--danger)'; 
            callBtn.onclick = () => endPeerCall(u.id); 
        } else { 
            callBtn.textContent = 'Call'; 
            callBtn.onclick = () => window.ringUser(u.id); 
        }
        actionsDiv.appendChild(callBtn);

        if (isCalling && iAmHost) {
            const selBtn = document.createElement('button'); 
            selBtn.className = 'action-btn'; 
            selBtn.textContent = (activeGuestId === u.id) ? 'Selected' : 'Mix';
            selBtn.onclick = () => { 
                activeGuestId = u.id; 
                renderUserList(); 
                window.setActiveGuest(u.id); 
            };
            actionsDiv.appendChild(selBtn);
        }
        
        if (iAmHost) {
            const pBtn = document.createElement('button'); 
            pBtn.className = 'action-btn'; 
            pBtn.textContent = '👑 Promote';
            pBtn.onclick = () => { 
                if(confirm(`Hand over Host to ${u.name}?`)) {
                    socket.emit('promote-to-host', { targetId: u.id });
                }
            };
            actionsDiv.appendChild(pBtn);

            const kBtn = document.createElement('button'); 
            kBtn.className = 'action-btn kick'; 
            kBtn.textContent = 'Kick';
            kBtn.onclick = () => window.kickUser(u.id);
            actionsDiv.appendChild(kBtn);
        }

        div.appendChild(nameSpan);
        div.appendChild(actionsDiv);
        list.appendChild(div);
    });
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div'); 
        d.className = 'video-container'; 
        d.id = `vid-${id}`;
        
        const v = document.createElement('video');
        v.autoplay = true;
        v.playsInline = true;
        d.appendChild(v);

        const h2 = document.createElement('h2'); 
        h2.textContent = callPeers[id] ? callPeers[id].name : "Guest"; 
        d.appendChild(h2);

        const videoGrid = $('videoGrid');
        if (videoGrid) {
            videoGrid.appendChild(d);
        }
    }

    const v = d.querySelector('video'); 
    if (v.srcObject !== stream) {
        v.srcObject = stream;
    }
}

function removeRemoteVideo(id) { 
    const el = document.getElementById(`vid-${id}`); 
    if(el) el.remove(); 
}

window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

if ($('openStreamBtn')) {
    $('openStreamBtn').addEventListener('click', () => { 
        const url = $('streamLinkInput').value; 
        if(url) window.open(url, '_blank'); 
    });
}
