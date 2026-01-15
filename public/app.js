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

            // If the channel closed unexpectedly, stop.
            if (channel.readyState !== 'open') {
                return;
            }

            // Slice the next chunk of data
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;

            // Calculate percentage for the UI status
            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            // Continue or Finish
            if (offset < buffer.byteLength) {
                setTimeout(sendLoop, 0); // Schedule next chunk immediately
            } else {
                console.log(`[Arcade] Transfer Complete.`);
                // Close the channel after a short delay to ensure delivery
                setTimeout(() => {
                    channel.close();
                }, 1000);
            }
        };

        // Kick off the loop
        sendLoop();
    };
}


// ======================================================
// 2. MAIN APP SETUP & VARIABLES
// ======================================================

console.log("Rebel Stream Host App Loaded"); 

// Initialize Socket.io (Manual connect)
const socket = io({ autoConnect: false });

// Helper function to select DOM elements
const $ = id => document.getElementById(id);

// --- GLOBAL VARIABLES ---
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let wasHost = false; // PATCH: Track role transition for migration
let latestUserList = [];
let currentOwnerId = null;

// --- VIP BOUNCER STATE ---
let isPrivateMode = false;
let allowedGuests = [];

// --- MEDIA STATE ---
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false; // "On Air" status

// --- ARCADE STATE ---
let activeToolboxFile = null;

// --- MIXER STATE (CANVAS ENGINE) ---
// This allows you to mix cameras and overlays before sending to stream
let audioContext = null;
let audioDestination = null;
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
// 3. CANVAS MIXER ENGINE (The "Broadcast" Logic)
// ======================================================

// This function runs 30 times a second to paint the video frame
function drawMixer() {
    if (!ctx) return;
    
    // 1. Paint Background (Black)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Get Source Elements
    const myVideo = $('localVideo'); // This is always YOU or YOUR SCREEN
    
    let guestVideo = null;
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`);
        if(el) guestVideo = el.querySelector('video');
    }

    // 3. Draw based on Layout Mode
    if (mixerLayout === 'SOLO') {
        // Full Screen: Host
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
    } 
    else if (mixerLayout === 'GUEST') {
        // Full Screen: Guest
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        } else {
            // Placeholder text if guest isn't ready
            ctx.fillStyle = '#333'; ctx.fillRect(0,0,canvas.width, canvas.height);
            ctx.fillStyle = '#fff'; ctx.font = "60px Arial"; ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest Signal.", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        // --- FIXED 16:9 SPLIT LOGIC ---
        // Instead of stretching, we fit the 16:9 video into half-width slots (960px).
        // A 960px wide 16:9 video is 540px tall. We center it vertically.
        
        const slotW = 960;
        const vidH = 540; // 960 / (16/9)
        const yOffset = (1080 - vidH) / 2;

        // Draw Host (Left)
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, yOffset, slotW, vidH);
        }
        
        // Draw Guest (Right)
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, slotW, yOffset, slotW, vidH);
        } else {
            ctx.fillStyle = '#333'; 
            ctx.fillRect(slotW, 0, slotW, canvas.height);
            ctx.fillStyle = '#fff'; 
            ctx.font = "48px Arial"; 
            ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest", slotW + (slotW/2), canvas.height/2);
        }
    }
    else if (mixerLayout === 'PIP') {
        // PICTURE-IN-PICTURE:
        // Host = full screen, Guest = small box in corner
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
        const pipW = 640; 
        const pipH = 360; 
        const x = canvas.width - pipW - 40;
        const y = canvas.height - pipH - 40;

        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(x-10, y-10, pipW+20, pipH+20);
        
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, x, y, pipW, pipH);
        }
    }

    // Loop
    requestAnimationFrame(drawMixer);
}

// Start the Mixer Engine
canvasStream = canvas.captureStream(30); // 30 FPS Broadcast Stream
drawMixer();

// --- MIXER CONTROLS EXPOSED TO WINDOW ---
window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    console.log(`Mixer Layout: ${mode}`);
    
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
    alert(`Guest Selected! Click 'Overlay' or 'Split' to see them on stream.`);
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

    // Reset all tabs
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));

    // Activate the selected one
    tabs[name].classList.add('active');
    contents[name].classList.add('active');

    // Remove notification badge
    tabs[name].classList.remove('has-new');
}

// Click Listeners for Tabs
if(tabs.stream) {
    tabs.stream.onclick = () => switchTab('stream');
}
if(tabs.room) {
    tabs.room.onclick = () => switchTab('room');
}
if(tabs.files) {
    tabs.files.onclick = () => switchTab('files');
}
if(tabs.users) {
    tabs.users.onclick = () => switchTab('users');
}


// ======================================================
// 5. DEVICE SETTINGS (Audio/Video/Mixer)
// ======================================================

const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); // Secondary Audio (Mixer)
const videoSource = $('videoSource');
const videoQuality = $('videoQuality'); // Resolution

if ($('settingsBtn')) {
    $('settingsBtn').addEventListener('click', () => {
        const isHidden = settingsPanel.style.display === 'none' || settingsPanel.style.display === '';
        settingsPanel.style.display = isHidden ? 'block' : 'none';
        
        if (isHidden) {
            getDevices();
        }
    });
}

if ($('closeSettingsBtn')) {
    $('closeSettingsBtn').addEventListener('click', () => {
        settingsPanel.style.display = 'none';
    });
}

async function getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return;
    }
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        // Clear lists
        audioSource.innerHTML = ''; 
        videoSource.innerHTML = '';
        if(audioSource2) audioSource2.innerHTML = '<option value="">-- None --</option>';

        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
                // Add to mixer
                if(audioSource2) audioSource2.appendChild(opt.cloneNode(true));
            }
            if (d.kind === 'videoinput') {
                videoSource.appendChild(opt);
            }
        });

        // Try to select the currently active device
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at) audioSource.value = at.getSettings().deviceId;
            if (vt) videoSource.value = vt.getSettings().deviceId;
        }
    } catch (e) { 
        console.error(e); 
    }
}

// Update media when dropdown changes
audioSource.onchange = startLocalMedia;
if(audioSource2) audioSource2.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;
if(videoQuality) videoQuality.onchange = startLocalMedia;


// ======================================================
// 6. MEDIA CONTROLS (CAMERA, MIC & MIXER ENGINE)
// ======================================================

async function startLocalMedia() {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }

    const quality = videoQuality ? videoQuality.value : 'ideal';
    
    let width = 1280;
    let height = 720;
    
    if (quality === 'max') {
        width = 1920;
        height = 1080;
    } else if (quality === 'low') {
        width = 640;
        height = 360;
    }

    const constraints = {
        video: { 
            width: { ideal: width }, 
            height: { ideal: height },
            deviceId: videoSource && videoSource.value ? { exact: videoSource.value } : undefined
        },
        audio: {
            deviceId: audioSource && audioSource.value ? { exact: audioSource.value } : undefined
        }
    };

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Attach to local video element
        const localVideo = $('localVideo');
        if (localVideo) {
            localVideo.srcObject = localStream;
        }

        // Initialize AudioContext for mixing
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        audioDestination = audioContext.createMediaStreamDestination();

        // 1) Primary Mic
        const micSource = audioContext.createMediaStreamSource(localStream);
        micSource.connect(audioDestination);

        // 2) Secondary Audio (If selected)
        if (audioSource2 && audioSource2.value) {
            try {
                const secondaryStream = await navigator.mediaDevices.getUserMedia({
                    audio: { deviceId: { exact: audioSource2.value } },
                    video: false
                });
                const secondarySource = audioContext.createMediaStreamSource(secondaryStream);
                secondarySource.connect(audioDestination);
            } catch (err) {
                console.warn('Secondary audio failed:', err);
            }
        }

        // Merge audioDestination with canvasStream to create final broadcastStream
        const finalStream = new MediaStream();

        // Append video from canvasStream
        canvasStream.getVideoTracks().forEach(track => {
            finalStream.addTrack(track);
        });

        // Append audio from audioDestination
        audioDestination.stream.getAudioTracks().forEach(track => {
            finalStream.addTrack(track);
        });

        // Use finalStream for broadcasting
        broadcastStream = finalStream;

        updateMediaButtons();
    } catch (err) {
        console.error('Error starting local media:', err);
        alert('Could not start camera/microphone. Check permissions and devices.');
    }
}

function stopLocalMedia() {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    updateMediaButtons();
}

async function startScreenShare() {
    if (isScreenSharing) return;

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const localVideo = $('localVideo');
        if (localVideo) {
            localVideo.srcObject = screenStream;
        }

        isScreenSharing = true;
        updateMediaButtons();
    } catch (err) {
        console.error('Screen share error:', err);
        alert('Failed to start screen share.');
    }
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    isScreenSharing = false;
    // Return localVideo to normal camera
    if (localStream) {
        const localVideo = $('localVideo');
        if (localVideo) {
            localVideo.srcObject = localStream;
        }
    }
    updateMediaButtons();
}

// Toggle Camera (Video Track Mute)
function toggleCamera() {
    if (!localStream) return;
    const videoTracks = localStream.getVideoTracks();
    if (!videoTracks.length) return;
    const enabled = videoTracks[0].enabled;
    videoTracks[0].enabled = !enabled;
    updateMediaButtons();
}

// Toggle Microphone (Audio Track Mute)
function toggleMic() {
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) return;
    const enabled = audioTracks[0].enabled;
    audioTracks[0].enabled = !enabled;
    updateMediaButtons();
}

// ======================================================
// 7. BROADCAST STREAM HANDLING (VIEWERS)
// ======================================================

let broadcastStream = null; // Final stream (canvas+audio) used for broadcasting

function connectViewer(socketId) {
    if (!broadcastStream) {
        console.warn("Cannot connect viewer: broadcastStream is not ready.");
        return;
    }

    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[socketId] = pc;

    // Add broadcast stream tracks
    broadcastStream.getTracks().forEach(track => {
        pc.addTrack(track, broadcastStream);
    });

    // Arcade - side channel
    // We'll send games/tools over this datachannel if loaded
    if (activeToolboxFile) {
        pushFileToPeer(pc, activeToolboxFile, (percent) => {
            const status = $('arcadeStatus');
            if (status) {
                status.textContent = `Sending ${activeToolboxFile.name}... ${percent}%`;
            }
        });
    }

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { 
                targetId: socketId, 
                candidate: e.candidate 
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Viewer ${socketId} connection state:`, pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            pc.close();
            delete viewerPeers[socketId];
        }
    };

    (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { targetId: socketId, sdp: offer });
    })();
}

function disconnectAllViewers() {
    Object.values(viewerPeers).forEach(pc => pc.close());
    Object.keys(viewerPeers).forEach(k => delete viewerPeers[k]);
}

// ======================================================
// 8. CALL HANDLING (1:1 WebRTC) 
// ======================================================

function startCall(targetId) {
    if (!localStream) {
        alert("Start your camera first.");
        return;
    }
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, stream: null };

    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate });
        }
    };

    pc.ontrack = (e) => {
        const remoteStream = e.streams[0];
        callPeers[targetId].stream = remoteStream;
        attachRemoteStream(targetId, remoteStream);
    };

    (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { targetId, sdp: offer });
    })();
}

function endPeerCall(targetId, silent = false) {
    const info = callPeers[targetId];
    if (!info) return;
    if (info.pc) info.pc.close();
    delete callPeers[targetId];

    const el = document.getElementById(`call-${targetId}`);
    if (el && el.parentNode) el.parentNode.removeChild(el);

    if (!silent) {
        // You can hook a system message here if you like
        // appendChat($('chatLogPrivate'), 'System', `Call with ${targetId} ended.`, Date.now());
    }
}

function attachRemoteStream(peerId, stream) {
    let container = document.getElementById(`call-${peerId}`);
    if (!container) {
        container = document.createElement('div');
        container.id = `call-${peerId}`;
        container.className = 'call-tile';

        const h = document.createElement('div');
        h.className = 'call-title';
        h.textContent = `Call with ${peerId}`;
        container.appendChild(h);

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        container.appendChild(video);

        const btnRow = document.createElement('div');
        btnRow.className = 'call-actions';
        const endBtn = document.createElement('button');
        endBtn.className = 'btn small danger';
        endBtn.textContent = 'Hang Up';
        endBtn.onclick = () => {
            socket.emit('call-end', { targetId: peerId });
            endPeerCall(peerId);
        };
        btnRow.appendChild(endBtn);
        container.appendChild(btnRow);

        const callArea = $('callArea');
        if (callArea) {
            callArea.appendChild(container);
        }
    }
}

// ======================================================
// 9. CHAT SYSTEM (Public/Private/Emojis)
// ======================================================

function appendChat(log, name, text, ts) {
    if (!log) return;
    const d = document.createElement('div');
    d.className = 'chat-line';
    
    const s = document.createElement('strong'); 
    s.textContent = name;
    const t = document.createElement('small'); 
    t.textContent = new Date(ts || Date.now()).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    
    d.appendChild(s); 
    d.appendChild(document.createTextNode(' ')); 
    d.appendChild(t); 
    d.appendChild(txt);
    log.appendChild(d); 
    log.scrollTop = log.scrollHeight;
}

// PUBLIC CHAT SEND
function sendPublic() {
    const inp = $('inputPublic');
    if (!inp) return;
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
if ($('btnSendPublic')) $('btnSendPublic').addEventListener('click', sendPublic);
if ($('inputPublic')) $('inputPublic').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPublic(); });

// PRIVATE CHAT SEND
function sendPrivate() {
    const inp = $('inputPrivate');
    if (!inp) return;
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
if ($('btnSendPrivate')) $('btnSendPrivate').addEventListener('click', sendPrivate);
if ($('inputPrivate')) $('inputPrivate').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPrivate(); });

// RECEIVE PUBLIC CHAT
socket.on('public-chat', ({ room, name, text, ts }) => {
    appendChat($('chatLogPublic'), name, text, ts);
});

// RECEIVE PRIVATE CHAT
socket.on('private-chat', ({ room, name, text, ts }) => {
    appendChat($('chatLogPrivate'), name, text, ts);
});

// ======================================================
// 10. FILE SHARE (classic via server up to 1MB)
// ======================================================

if ($('fileInput')) {
    $('fileInput').addEventListener('change', () => {
        const file = $('fileInput').files[0];
        const label = $('fileNameLabel');
        const sendBtn = $('sendFileBtn');
        if (!file) {
            if (label) label.textContent = 'No file selected';
            if (sendBtn) sendBtn.disabled = true;
            return;
        }
        if (label) label.textContent = file.name;
        if (sendBtn) sendBtn.disabled = file.size > 1024 * 1024;

        if (file.size > 1024 * 1024) {
            alert('File too big for classic share (1MB max). Use Arcade for tools/games.');
        }
    });
}

if ($('sendFileBtn')) {
    $('sendFileBtn').addEventListener('click', () => {
        const fileInput = $('fileInput');
        if (!fileInput || !fileInput.files[0] || !currentRoom) return;
        const file = fileInput.files[0];

        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            socket.emit('file-share', {
                room: currentRoom,
                name: file.name,
                size: file.size,
                mime: file.type,
                dataUrl
            });
        };
        reader.readAsDataURL(file);
    });
}

socket.on('file-share', ({ from, name, size, mime, url }) => {
    const log = $('fileLog');
    if (!log) return;

    const row = document.createElement('div');
    row.className = 'file-row';

    row.innerHTML = `
      <span class="file-name">${name}</span>
      <span class="file-meta">${(size/1024).toFixed(1)}KB • ${from}</span>
      <a href="${url}" download="${name}" class="btn small">Download</a>
    `;
    log.appendChild(row);

    // Highlight Files tab
    if (tabs.files) {
        tabs.files.classList.add('has-new');
    }
});

// ======================================================
// 11. ARCADE (P2P TOOLBOX) - HOST SIDE UI
// ======================================================

if ($('arcadeInput')) {
    $('arcadeInput').addEventListener('change', () => {
        const file = $('arcadeInput').files[0];
        if (!file) return;
        activeToolboxFile = file;
        const status = $('arcadeStatus');
        if (status) {
            status.textContent = `Loaded: ${file.name} (P2P Ready)`;
        }
        // Optionally, highlight the Files tab so host remembers something is loaded
        if (tabs.files) {
            tabs.files.classList.add('has-new');
        }
    });
}


// ======================================================
// 12. SOCKET & ROOM LOGIC
// ======================================================

socket.on('connect', () => { 
    if ($('signalStatus')) {
        $('signalStatus').className = 'status-dot status-connected'; 
        $('signalStatus').textContent = 'Connected'; 
    }
    myId = socket.id; 
});

socket.on('disconnect', () => { 
    if ($('signalStatus')) {
        $('signalStatus').className = 'status-dot status-disconnected'; 
        $('signalStatus').textContent = 'Disconnected'; 
    }
});

// Join Button Logic
if ($('joinBtn')) {
    $('joinBtn').addEventListener('click', () => {
        const room = $('roomInput').value.trim();
        if (!room) return;
        
        currentRoom = room; 
        userName = $('nameInput').value.trim() || 'Host';
        
        socket.connect();
        socket.emit('join-room', { room, name: userName });
        
        // Update UI
        $('joinBtn').disabled = true; 
        if ($('leaveBtn')) $('leaveBtn').disabled = false;
        
        updateLink(room);
        startLocalMedia();
    });
}

if ($('leaveBtn')) {
    $('leaveBtn').addEventListener('click', () => {
        window.location.reload();
    });
}

// Helper to generate QR Code
function generateQR(url) {
    const qrContainer = $('qrcode');
    if (qrContainer && typeof QRCode !== 'undefined') {
        qrContainer.innerHTML = ""; // Clear existing
        new QRCode(qrContainer, {
            text: url,
            width: 128,
            height: 128,
            colorDark : "#4af3a3",
            colorLight : "#101524"
        });
    }
}

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    const finalUrl = url.toString();
    if ($('streamLinkInput')) $('streamLinkInput').value = finalUrl;
    
    generateQR(finalUrl);
}

// New User Joined Logic
socket.on('user-joined', ({ id, name }) => {
    // VIP Bouncer check
    if (iAmHost && isPrivateMode) {
        const isAllowed = allowedGuests.some(g => g.toLowerCase() === name.toLowerCase());
        if (!isAllowed) {
            console.log(`[Bouncer] Kicking ${name}`);
            socket.emit('kick-user', id);
            return;
        }
    }

    // If I'm currently live, connect them to the stream
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

// 🔧 ROOM UPDATE (title, lock, users, viewer count)
socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users;
    currentOwnerId = ownerId;
    
    // Sync Title from Server
    if (streamTitle && $('streamTitleInput')) {
        $('streamTitleInput').value = streamTitle;
        updateLink($('roomInput').value || currentRoom);
    }

    // Sync Lock Button
    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? 'Unlock Room' : 'Lock Room';
        $('lockRoomBtn').onclick = () => { 
            if(iAmHost) {
                socket.emit('lock-room', !locked); 
            }
        };
    }

    // ✅ Host-side Room + Viewer Count (top-right)
    if ($('roomInfo')) {
        const total = Array.isArray(latestUserList) ? latestUserList.length : 0;
        const viewers = Math.max(total - 1, 0); // assume 1 host
        const roomLabel = currentRoom || ($('roomInput') && $('roomInput').value.trim()) || 'No room';
        $('roomInfo').textContent = `${roomLabel} • ${viewers} viewer${viewers === 1 ? '' : 's'}`;
    }

    renderUserList();
});

// Role / host change
socket.on('role', async ({ isHost }) => {
    wasHost = iAmHost;
    iAmHost = isHost;
    
    if ($('localContainer')) {
        $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    }
    if ($('hostControls')) $('hostControls').style.display = isHost ? 'block' : 'none';
    
    if (isHost && !wasHost && currentRoom) {
        await handleStartStream();
    }
    
    renderUserList();
});

// ======================================================
// 13. HOST CONTROLS (TITLE, SLUG, VIP)
// ======================================================

// UPDATE STREAM TITLE
if ($('updateTitleBtn')) {
    $('updateTitleBtn').addEventListener('click', () => {
        const title = $('streamTitleInput').value.trim();
        if (title) socket.emit('update-stream-title', title);
    });
}

if ($('streamTitleInput')) {
    $('streamTitleInput').addEventListener('keydown', (e) => {
        if(e.key === 'Enter') {
            const title = $('streamTitleInput').value.trim();
            if (title) socket.emit('update-stream-title', title);
        }
    });
}

// UPDATE LINK SLUG
if ($('updateSlugBtn')) {
    $('updateSlugBtn').addEventListener('click', () => {
        const slug = $('slugInput').value.trim();
        if (slug) updateLink(slug);
    });
}

// VIP PRIVATE MODE TOGGLE
if ($('togglePrivateBtn')) {
    $('togglePrivateBtn').addEventListener('click', () => {
        isPrivateMode = !isPrivateMode;
        $('togglePrivateBtn').textContent = isPrivateMode ? 'ON' : 'OFF';
        $('guestListPanel').style.display = isPrivateMode ? 'block' : 'none';
    });
}

// ADD GUEST NAME
if ($('addGuestBtn')) {
    $('addGuestBtn').addEventListener('click', () => {
        const name = $('guestNameInput').value.trim();
        if (!name) return;
        allowedGuests.push(name);
        $('guestNameInput').value = '';
        
        const list = $('guestListDisplay');
        if (list) {
            const li = document.createElement('div');
            li.className = 'guest-tag';
            li.textContent = name;
            list.appendChild(li);
        }
    });
}

// ROOM LOCK BUTTON
if ($('lockRoomBtn')) {
    $('lockRoomBtn').addEventListener('click', () => {
        if (iAmHost) {
            socket.emit('lock-room', true);
        }
    });
}

// USER LIST RENDER
function renderUserList() {
    const container = $('userList');
    if (!container) return;
    container.innerHTML = '';

    (latestUserList || []).forEach(u => {
        const row = document.createElement('div');
        row.className = 'user-row';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = u.name + (u.id === currentOwnerId ? ' 👑' : '');
        row.appendChild(nameSpan);

        if (iAmHost && u.id !== myId) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'btn small danger';
            kickBtn.textContent = 'Kick';
            kickBtn.onclick = () => socket.emit('kick-user', u.id);
            row.appendChild(kickBtn);

            const promoteBtn = document.createElement('button');
            promoteBtn.className = 'btn small';
            promoteBtn.textContent = 'Make Host';
            promoteBtn.onclick = () => socket.emit('promote-to-host', { targetId: u.id });
            row.appendChild(promoteBtn);

            const callBtn = document.createElement('button');
            callBtn.className = 'btn small secondary';
            callBtn.textContent = 'Call';
            callBtn.onclick = () => startCall(u.id);
            row.appendChild(callBtn);

            const mixBtn = document.createElement('button');
            mixBtn.className = 'btn small';
            mixBtn.textContent = 'Mixer';
            mixBtn.onclick = () => window.setActiveGuest(u.id);
            row.appendChild(mixBtn);
        }
        container.appendChild(row);
    });
}

// ======================================================
// 14. STREAM START / STOP / BUTTON HOOKS
// ======================================================

async function handleStartStream() {
    if (!broadcastStream) {
        await startLocalMedia();
    }
    isStreaming = true;
    Object.keys(viewerPeers).forEach(id => connectViewer(id));
    if ($('startStreamBtn')) {
        $('startStreamBtn').textContent = 'Stop Stream';
        $('startStreamBtn').classList.add('danger');
    }
}

function handleStopStream() {
    isStreaming = false;
    disconnectAllViewers();
    if ($('startStreamBtn')) {
        $('startStreamBtn').textContent = 'Start Stream';
        $('startStreamBtn').classList.remove('danger');
    }
}

if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!isStreaming) {
            await handleStartStream();
        } else {
            handleStopStream();
        }
    });
}

if ($('toggleCamBtn')) {
    $('toggleCamBtn').addEventListener('click', toggleCamera);
}

if ($('toggleMicBtn')) {
    $('toggleMicBtn').addEventListener('click', toggleMic);
}

if ($('shareScreenBtn')) {
    $('shareScreenBtn').addEventListener('click', () => {
        if (!isScreenSharing) startScreenShare();
        else stopScreenShare();
    });
}

// Update buttons based on current track states
function updateMediaButtons() {
    if ($('toggleCamBtn')) {
        let label = 'Camera Off';
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack && !videoTrack.enabled) {
                label = 'Camera Off';
            } else {
                label = 'Camera On';
            }
        }
        $('toggleCamBtn').textContent = label;
    }

    if ($('toggleMicBtn')) {
        let label = 'Mute';
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack && !audioTrack.enabled) {
                label = 'Unmute';
            } else {
                label = 'Mute';
            }
        }
        $('toggleMicBtn').textContent = label;
    }

    if ($('shareScreenBtn')) {
        $('shareScreenBtn').textContent = isScreenSharing ? 'Stop Share' : 'Share Screen';
    }
}

// ======================================================
// 15. CALL SIGNALING (Incoming Offers/Answers)
// ======================================================

socket.on('webrtc-offer', async ({ sdp, from }) => {
    const forCall = !!callPeers[from];
    if (forCall) {
        const pc = new RTCPeerConnection(iceConfig);
        callPeers[from] = { pc, stream: null };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit('webrtc-ice-candidate', { targetId: from, candidate: e.candidate });
            }
        };

        pc.ontrack = (e) => {
            const remoteStream = e.streams[0];
            callPeers[from].stream = remoteStream;
            attachRemoteStream(from, remoteStream);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (!localStream) await startLocalMedia();
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('webrtc-answer', { targetId: from, sdp: ans });
    } else {
        const pc = new RTCPeerConnection(iceConfig);
        viewerPeers[from] = pc;

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit('webrtc-ice-candidate', { targetId: from, candidate: e.candidate });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`Viewer inbound ${from} connection:`, pc.connectionState);
        };

        pc.ondatachannel = (ev) => {
            console.log('Host got datachannel from viewer (not used):', ev.channel.label);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (!broadcastStream) await startLocalMedia();
        broadcastStream.getTracks().forEach(track => pc.addTrack(track, broadcastStream));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('webrtc-answer', { targetId: from, sdp: ans });
    }
});

socket.on('webrtc-answer', async ({ sdp, from }) => {
    if (callPeers[from] && callPeers[from].pc) {
        await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } else if (viewerPeers[from]) {
        await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp));
    }
});

socket.on('webrtc-ice-candidate', async ({ candidate, from }) => {
    let pc = null;
    if (callPeers[from] && callPeers[from].pc) {
        pc = callPeers[from].pc;
    } else {
        pc = viewerPeers[from];
    }
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.warn('Failed to add ICE candidate:', err);
        }
    }
});

// Call end from remote
socket.on('call-end', ({ targetId }) => {
    endPeerCall(targetId, true);
});
