// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
// This handles splitting games/tools into chunks 
// and sending them securely over WebRTC to all viewers.

const CHUNK_SIZE = 16 * 1024; // 16KB chunks (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit to prevent crashes

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) {
        return;
    }

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
let latestUserList = [];
let currentOwnerId = null;

// --- VIP BOUNCER STATE ---
let isPrivateMode = false;
let allowedGuests = [];

// --- MEDIA STATE ---
let localStream = null;
let screenStream = null;
let mixedStream = null;      // NEW: mixed mic + desktop
let audioContext = null;     // NEW: audio engine
let isScreenSharing = false;
let isStreaming = false;     // "On Air" status

// --- ARCADE STATE ---
let activeToolboxFile = null;

// --- CONNECTION STORAGE ---
const viewerPeers = {}; // One-way connections (Broadcast)
const callPeers = {};   // Two-way connections (1:1 Calls)

// --- ICE CONFIGURATION (Servers) ---
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ======================================================
// 3. TAB NAVIGATION INTERFACE
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

// Click Listeners for Tabs (defensive)
Object.keys(tabs).forEach(key => {
    if (tabs[key]) {
        tabs[key].onclick = () => switchTab(key);
    }
});


// ======================================================
// 4. DEVICE SETTINGS (Audio/Video Selection)
// ======================================================

const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const videoSource = $('videoSource');

// NEW: premium selectors
const audioProfile = $('audioProfile');   // voice / music
const videoQuality = $('videoQuality');   // 720 / 1080

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
        
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
            }
            if (d.kind === 'videoinput') {
                videoSource.appendChild(opt);
            }
        });

        // Try to select the currently active device
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at && at.getSettings().deviceId) audioSource.value = at.getSettings().deviceId;
            if (vt && vt.getSettings().deviceId) videoSource.value = vt.getSettings().deviceId;
        }
    } catch (e) { 
        console.error(e); 
    }
}

// Update media when dropdown changes
if (audioSource) audioSource.onchange = startLocalMedia;
if (videoSource) videoSource.onchange = startLocalMedia;
if (audioProfile) audioProfile.onchange = startLocalMedia;
if (videoQuality) videoQuality.onchange = startLocalMedia;


// ======================================================
// 5. MEDIA CONTROLS (CAMERA & MIC – with Profiles)
// ======================================================

async function startLocalMedia() {
    // If sharing screen, don't override with camera
    if (isScreenSharing) {
        return; 
    }

    // Stop previous tracks
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    // --- 1. VIDEO CONSTRAINTS ---
    // Default: 720p
    let videoConstraints = {
        deviceId: videoSource && videoSource.value ? { exact: videoSource.value } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 }
    };

    // If 1080p is selected
    if (videoQuality && videoQuality.value === '1080') {
        console.log("[Media] Switching to 1080p Premium Video");
        videoConstraints = {
            deviceId: videoSource && videoSource.value ? { exact: videoSource.value } : undefined,
            width: { ideal: 1920, max: 3840 },
            height: { ideal: 1080, max: 2160 },
            frameRate: { ideal: 30 }
        };
    }

    // --- 2. AUDIO CONSTRAINTS ---
    // Default: Voice (speech-optimised)
    let audioConstraints = {
        deviceId: audioSource && audioSource.value ? { exact: audioSource.value } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
    };

    // Music / DJ Mode – raw as possible
    if (audioProfile && audioProfile.value === 'music') {
        console.log("[Media] Switching to Music/DJ Audio Profile");
        audioConstraints = {
            deviceId: audioSource && audioSource.value ? { exact: audioSource.value } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
            sampleSize: 16
        };
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: videoConstraints
        });
        
        // Set local video element
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; // IMPORTANT: Mute local echo

        // Update all connected peers with new stream
        const tracks = localStream.getTracks();
        
        const updatePC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            tracks.forEach(t => {
                const sender = senders.find(s => s.track && s.track.kind === t.kind);
                if (sender) {
                    sender.replaceTrack(t);
                }
            });
        };

        // Update Broadcasting Viewers
        Object.values(viewerPeers).forEach(updatePC);
        
        // Update 1:1 Callers
        Object.values(callPeers).forEach(p => updatePC(p.pc));

        // Enable UI
        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { 
        console.error("Media Error:", e); 
        alert("Could not start media. If using 1080p/DJ mode, make sure your devices support it and browser has permission."); 
    }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];

    // Update Camera Button
    if ($('toggleCamBtn')) {
        const isCamOn = vTrack && vTrack.enabled;
        $('toggleCamBtn').textContent = isCamOn ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !isCamOn);
    }

    // Update Mic Button
    if ($('toggleMicBtn')) {
        const isMicOn = aTrack && aTrack.enabled;
        $('toggleMicBtn').textContent = isMicOn ? 'Mute' : 'Unmute';
        $('toggleMicBtn').classList.toggle('danger', !isMicOn);
    }
}

if ($('toggleMicBtn')) {
    $('toggleMicBtn').addEventListener('click', () => {
        if (!localStream) return;
        const track = localStream.getAudioTracks()[0];
        if (track) { 
            track.enabled = !track.enabled; 
            updateMediaButtons(); 
        }
    });
}

if ($('toggleCamBtn')) {
    $('toggleCamBtn').addEventListener('click', () => {
        if (!localStream) return;
        const track = localStream.getVideoTracks()[0];
        if (track) { 
            track.enabled = !track.enabled; 
            updateMediaButtons(); 
        }
    });
}


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
                    if (vSender && screenVideoTrack) vSender.replaceTrack(screenVideoTrack);
                    const aSender = senders.find(s => s.track && s.track.kind === 'audio');
                    if (aSender && finalAudioTrack) aSender.replaceTrack(finalAudioTrack);
                };

                Object.values(viewerPeers).forEach(updatePC);
                Object.values(callPeers).forEach(p => updatePC(p.pc));
                if (screenVideoTrack) {
                    screenVideoTrack.onended = stopScreenShare;
                }

            } catch(e) { 
                console.error("Screen share cancelled", e); 
            }
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;

    // Stop the screen tracks
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
    }
    
    // Close mixer if running
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    mixedStream = null;
    screenStream = null;
    isScreenSharing = false;
    
    // Reset Button UI
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    
    // Switch back to Camera
    $('localVideo').srcObject = localStream;
    
    if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        const micTrack = localStream.getAudioTracks()[0];
        const updatePC = (pc) => {
            if(!pc) return;
            const senders = pc.getSenders();
            const vSender = senders.find(s => s.track && s.track.kind === 'video');
            if (vSender && camTrack) vSender.replaceTrack(camTrack);
            const aSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (aSender && micTrack) aSender.replaceTrack(micTrack);
        };
        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));
    }
}


// ======================================================
// 7. BROADCAST STREAMING (1-to-Many)
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
            Object.values(viewerPeers).forEach(pc => pc.close());
            for (const k in viewerPeers) delete viewerPeers[k];
            
        } else {
            // --- START STREAMING ---
            if (!localStream) await startLocalMedia();
            
            isStreaming = true;
            $('startStreamBtn').textContent = "Stop Stream"; 
            $('startStreamBtn').classList.add('danger');
            
            // Connect to every user currently in the list
            latestUserList.forEach(u => { 
                if (u.id !== myId) {
                    connectViewer(u.id); 
                }
            });
        }
    });
}


// ======================================================
// 8. P2P CALLING (1-to-1)
// ======================================================

// HANGUP BUTTON: Ends call connection ONLY. Keeps camera ON.
if ($('hangupBtn')) {
    $('hangupBtn').addEventListener('click', () => {
        // Only end peer calls, do not stop local media
        Object.keys(callPeers).forEach(id => endPeerCall(id));
    });
}

// Incoming Call Alert
socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`Incoming call from ${from}. Accept?`)) {
        await callPeer(fromId);
    }
});

// Start a Call
async function callPeer(targetId) {
    if (!localStream) await startLocalMedia();
    
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, name: "Peer" };
    
    pc.onicecandidate = e => { 
        if (e.candidate) {
            socket.emit('call-ice', { targetId, candidate: e.candidate }); 
        }
    };

    // Show remote video when received
    pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]);
    
    // Add local video to send
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call-offer', { targetId, offer });
    
    renderUserList();
}

// Receive a Call
socket.on('incoming-call', async ({ from, name, offer }) => {
    if (!localStream) await startLocalMedia();
    
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[from] = { pc, name };
    
    pc.onicecandidate = e => { 
        if (e.candidate) {
            socket.emit('call-ice', { targetId: from, candidate: e.candidate }); 
        }
    };
    
    pc.ontrack = e => addRemoteVideo(from, e.streams[0]);
    
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call-answer', { targetId: from, answer });
    
    renderUserList();
});

socket.on('call-answer', async ({ from, answer }) => { 
    if (callPeers[from]) {
        await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer)); 
    }
});

socket.on('call-ice', ({ from, candidate }) => { 
    if (callPeers[from]) {
        callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)); 
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
// 9. WEBRTC SIGNALING (BROADCAST)
// ======================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    pc.onicecandidate = e => { 
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); 
        }
    };
    
    // Choose stream source (Screen or Camera)
    const stream = isScreenSharing ? (screenStream || localStream) : localStream;
    if(stream) {
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
    }
    
    // --- ARCADE AUTO-PUSH ---
    // If a tool is loaded, send it to the new viewer immediately
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing tool to ${targetId}`);
        pushFileToPeer(pc, activeToolboxFile, null); 
    }
    // ------------------------

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
// 10. SOCKET & ROOM LOGIC
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
    if (!room) return;
    
    currentRoom = room; 
    userName = $('nameInput').value.trim() || 'Host';
    
    socket.connect();
    socket.emit('join-room', { room, name: userName });
    
    // Update UI
    $('joinBtn').disabled = true; 
    $('leaveBtn').disabled = false;
    
    updateLink(room);
    startLocalMedia();
});

if ($('leaveBtn')) {
    $('leaveBtn').addEventListener('click', () => {
        window.location.reload();
    });
}

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}

// New User Joined Logic
socket.on('user-joined', ({ id, name }) => {
    
    // --- VIP BOUNCER CHECK ---
    if (iAmHost && isPrivateMode) {
        const isAllowed = allowedGuests.some(g => g.toLowerCase() === name.toLowerCase());
        if (!isAllowed) {
            console.log(`[Bouncer] Kicking ${name}`);
            socket.emit('kick-user', id);
            return; // Stop here, do not welcome
        }
    }
    // -------------------------

    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    
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

// Room Update (Handles Title, Locks, User List)
socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users;
    currentOwnerId = ownerId;
    
    // Sync Title from Server
    if (streamTitle && $('streamTitleInput')) {
        $('streamTitleInput').value = streamTitle;
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
    renderUserList();
});

socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    if ($('localContainer')) {
        $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    }
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});


// ======================================================
// 11. HOST CONTROLS (TITLE, SLUG, VIP)
// ======================================================

// --- UPDATE STREAM TITLE ---
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

// --- UPDATE LINK NAME (SLUG) ---
if ($('updateSlugBtn')) {
    $('updateSlugBtn').addEventListener('click', () => {
        const slug = $('slugInput').value.trim();
        if (slug) updateLink(slug);
    });
}

if ($('slugInput')) {
    $('slugInput').addEventListener('keydown', (e) => {
        if(e.key === 'Enter') {
            const slug = $('slugInput').value.trim();
            if (slug) updateLink(slug);
        }
    });
}

// --- VIP GUEST LIST LOGIC ---
if ($('togglePrivateBtn')) {
    $('togglePrivateBtn').addEventListener('click', () => {
        isPrivateMode = !isPrivateMode;
        
        // Update Button UI
        $('togglePrivateBtn').textContent = isPrivateMode ? "ON" : "OFF";
        $('togglePrivateBtn').className = isPrivateMode ? "btn small danger" : "btn small secondary";
        $('guestListPanel').style.display = isPrivateMode ? "block" : "none";
        
        // If turned ON, kick everyone not on the list immediately
        if (isPrivateMode) {
            latestUserList.forEach(u => {
                if (u.id !== myId) {
                    const allowed = allowedGuests.some(g => g.toLowerCase() === u.name.toLowerCase());
                    if (!allowed) {
                        socket.emit('kick-user', u.id);
                    }
                }
            });
        }
    });
}

if ($('addGuestBtn')) {
    $('addGuestBtn').addEventListener('click', () => {
        const name = $('guestNameInput').value.trim();
        if (name && !allowedGuests.includes(name)) {
            allowedGuests.push(name);
            renderGuestList();
            $('guestNameInput').value = '';
        }
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
// 12. CHAT SYSTEM (Public/Private/Emojis)
// ======================================================

function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    
    // Secure Elements (No InnerHTML - Anti-XSS)
    const s = document.createElement('strong'); s.textContent = name;
    const t = document.createElement('small'); t.textContent = new Date(ts).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    
    d.appendChild(s); 
    d.appendChild(document.createTextNode(' ')); 
    d.appendChild(t); 
    d.appendChild(txt);
    log.appendChild(d); 
    log.scrollTop = log.scrollHeight;
}

function sendPublic() {
    const inp = $('inputPublic'); const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPublic').addEventListener('click', sendPublic);
$('inputPublic').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPublic(); });

function sendPrivate() {
    const inp = $('inputPrivate'); const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPrivate').addEventListener('click', sendPrivate);
$('inputPrivate').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPrivate(); });

// Receive Socket Messages
socket.on('public-chat', d => { 
    appendChat($('chatLogPublic'), d.name, d.text, d.ts); 
    if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); 
});
socket.on('private-chat', d => { 
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts); 
    if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); 
});

// Emoji Listeners
if ($('emojiStripPublic')) {
    $('emojiStripPublic').addEventListener('click', e => { 
        if(e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; 
    });
}
if ($('emojiStripPrivate')) {
    $('emojiStripPrivate').addEventListener('click', e => { 
        if(e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; 
    });
}


// ======================================================
// 13. FILE SHARING TAB (Document sharing)
// ======================================================

const fileInput = $('fileInput');
fileInput.addEventListener('change', () => { 
    if(fileInput.files.length) { 
        $('fileNameLabel').textContent = fileInput.files[0].name; 
        $('sendFileBtn').disabled = false; 
    } 
});

$('sendFileBtn').addEventListener('click', () => {
    const file = fileInput.files[0];
    
    // CRASH PREVENTION (Limit Size)
    if(file.size > 1024 * 1024) {
        alert("File too large for chat share (Limit: 1MB). Use 'Arcade' for larger P2P transfers.");
        return;
    }

    if(!file || !currentRoom) return;
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

// Secure rendering (no innerHTML)
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
    if(!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ======================================================
// 14. ARCADE INPUT LOGIC
// ======================================================

const arcadeInput = $('arcadeInput');
if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if(!file) return;
        
        activeToolboxFile = file;
        $('arcadeStatus').textContent = `Active Tool: ${file.name}`;
        
        // Push file to all currently connected peers
        Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
    });
}


// ======================================================
// 15. USER LIST & KICKING
// ======================================================

function renderUserList() {
    const list = $('userList'); 
    list.innerHTML = ''; // Clear list

    latestUserList.forEach(u => {
        if (u.id === myId) return; // Don't list myself

        const div = document.createElement('div'); 
        div.className = 'user-item';
        
        // Secure Name Rendering (No InnerHTML)
        const nameSpan = document.createElement('span');
        if (u.id === currentOwnerId) nameSpan.textContent = '👑 ';
        nameSpan.textContent += u.name;

        // Action Buttons Container
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'user-actions';

        const isCalling = !!callPeers[u.id];
        
        const actionBtn = document.createElement('button');
        actionBtn.className = 'action-btn';
        
        if (isCalling) {
            actionBtn.textContent = 'End Call';
            actionBtn.style.cssText = 'border-color:var(--danger); color:var(--danger)';
            actionBtn.onclick = () => endPeerCall(u.id);
        } else {
            actionBtn.textContent = 'Call';
            actionBtn.onclick = () => window.ringUser(u.id);
        }
        actionsDiv.appendChild(actionBtn);

        if (iAmHost) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'action-btn kick';
            kickBtn.textContent = 'Kick';
            kickBtn.onclick = () => window.kickUser(u.id);
            actionsDiv.appendChild(kickBtn);
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

        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); 
    if(v.srcObject !== stream) v.srcObject = stream;
}

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
