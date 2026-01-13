// ==========================================
// 1. ARCADE / SIDE-LOADER ENGINE
// ==========================================
// This handles splitting large files into small chunks
// so they can be sent over the secure WebRTC connection.

const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit to prevent crashing

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;

    // Create a specific data channel for the file transfer
    const channel = pc.createDataChannel("side-load-pipe");

    channel.onopen = async () => {
        console.log(`[Arcade] Channel open. Starting transfer of: ${file.name}`);

        // 1. Send the Metadata first (Name, Size, Type)
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

        // 3. Start the sending loop
        const sendLoop = () => {
            // Check if the network buffer is full. If so, wait.
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }

            // If the channel closed unexpectedly, stop.
            if (channel.readyState !== 'open') return;

            // Slice the next chunk of data
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;

            // Calculate percentage for the UI
            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            // Continue or Finish
            if (offset < buffer.byteLength) {
                setTimeout(sendLoop, 0); // Schedule next chunk immediately
            } else {
                console.log(`[Arcade] Transfer Complete: ${file.name}`);
                // Close the channel after a short delay to ensure delivery
                setTimeout(() => channel.close(), 1000);
            }
        };

        // Kick off the loop
        sendLoop();
    };
}


// ==========================================
// 2. MAIN APP INITIALIZATION
// ==========================================

console.log("Rebel Stream Host App Fully Loaded");

// Initialize Socket.io (Auto-connect disabled until user joins)
const socket = io({ autoConnect: false });

// Helper to select elements easily
const $ = id => document.getElementById(id);


// ==========================================
// 3. GLOBAL VARIABLES & STATE
// ==========================================

// Room State
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let latestUserList = [];
let currentOwnerId = null;

// VIP Bouncer State
let isPrivateMode = false;
let allowedGuests = [];

// Media State
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false;

// Arcade State
let activeToolboxFile = null;

// WebRTC Connections
const viewerPeers = {}; // Connections for Broadcasting (One-Way)
const callPeers = {};   // Connections for Video Calls (Two-Way)

// ICE Configuration (STUN Servers)
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
    ? { iceServers: ICE_SERVERS }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// ==========================================
// 4. TAB NAVIGATION LOGIC
// ==========================================

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

    // Remove 'active' class from all tabs and contents
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));

    // Add 'active' class to the selected one
    tabs[name].classList.add('active');
    contents[name].classList.add('active');

    // Remove the red notification dot
    tabs[name].classList.remove('has-new');
}

// Attach click listeners to tabs
if (tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if (tabs.room) tabs.room.onclick = () => switchTab('room');
if (tabs.files) tabs.files.onclick = () => switchTab('files');
if (tabs.users) tabs.users.onclick = () => switchTab('users');


// ==========================================
// 5. DEVICE SETTINGS (Camera/Mic Selection)
// ==========================================

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

if ($('closeSettingsBtn')) {
    $('closeSettingsBtn').addEventListener('click', () => {
        settingsPanel.style.display = 'none';
    });
}

async function getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        // Clear existing options
        audioSource.innerHTML = '';
        videoSource.innerHTML = '';

        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            if (d.kind === 'audioinput') audioSource.appendChild(opt);
            if (d.kind === 'videoinput') videoSource.appendChild(opt);
        });

        // Select the currently active device if possible
        if (localStream) {
            const at = localStream.getAudioTracks()[0];
            const vt = localStream.getVideoTracks()[0];
            if (at) audioSource.value = at.getSettings().deviceId;
            if (vt) videoSource.value = vt.getSettings().deviceId;
        }
    } catch (e) {
        console.error("Error fetching devices:", e);
    }
}

// Restart media if the user changes the device in the dropdown
audioSource.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;


// ==========================================
// 6. MEDIA CONTROL FUNCTIONS
// ==========================================

async function startLocalMedia() {
    if (isScreenSharing) return; // Do not interrupt screen sharing

    // Stop previous tracks if they exist
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
        audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
        video: { deviceId: videoSource.value ? { exact: videoSource.value } : undefined }
    };

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // Update Local Video Element
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; // Always mute local video to prevent feedback loops

        // If we are already connected to people, replace the track in the connection
        const tracks = localStream.getTracks();
        const updatePC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            tracks.forEach(t => {
                const sender = senders.find(s => s.track && s.track.kind === t.kind);
                if (sender) sender.replaceTrack(t);
            });
        };

        // Update all viewers and callers
        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));

        // Enable buttons
        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) {
        console.error(e);
        alert("Could not start camera. Check permissions.");
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

// Button Listeners
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


// ==========================================
// 7. SCREEN SHARING
// ==========================================

if ($('shareScreenBtn')) {
    $('shareScreenBtn').addEventListener('click', async () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                isScreenSharing = true;
                
                // Update Button
                $('shareScreenBtn').textContent = 'Stop Screen';
                $('shareScreenBtn').classList.add('danger');

                // Show screen locally
                $('localVideo').srcObject = screenStream;

                // Send screen track to all peers
                const screenTrack = screenStream.getVideoTracks()[0];
                const updatePC = (pc) => {
                    if (!pc) return;
                    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) sender.replaceTrack(screenTrack);
                };

                Object.values(viewerPeers).forEach(updatePC);
                Object.values(callPeers).forEach(p => updatePC(p.pc));

                // Listen for the browser's native "Stop Sharing" button
                screenTrack.onended = stopScreenShare;

            } catch (e) {
                console.error("Screen Share cancelled", e);
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

    screenStream = null;
    isScreenSharing = false;
    
    // Reset Button
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');

    // Switch back to Camera
    $('localVideo').srcObject = localStream;

    if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        const updatePC = (pc) => {
            if (!pc) return;
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(camTrack);
        };
        Object.values(viewerPeers).forEach(updatePC);
        Object.values(callPeers).forEach(p => updatePC(p.pc));
    }
}


// ==========================================
// 8. STREAMING LOGIC (BROADCAST)
// ==========================================

if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        // Security check: Only host can stream
        if (!currentRoom || !iAmHost) return alert("Host only functionality.");

        if (isStreaming) {
            // --- STOP STREAMING ---
            isStreaming = false;
            $('startStreamBtn').textContent = "Start Stream";
            $('startStreamBtn').classList.remove('danger');

            // Close all viewer connections
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
                if (u.id !== myId) connectViewer(u.id);
            });
        }
    });
}


// ==========================================
// 9. CALLING LOGIC (1:1 VIDEO)
// ==========================================

// --- END CALL BUTTON ---
if ($('hangupBtn')) {
    $('hangupBtn').addEventListener('click', () => {
        // 1. Close all peer-to-peer calls
        Object.keys(callPeers).forEach(id => endPeerCall(id));
        
        // 2. DO NOT turn off the camera logic.
        // User requested to keep camera on, just end the call connection.
        console.log("Calls ended. Camera remains active.");
    });
}

// Receive Ring Alert
socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`Incoming call from ${from}. Accept?`)) {
        await callPeer(fromId);
    }
});

// Initiating a Call
async function callPeer(targetId) {
    if (!localStream) await startLocalMedia();
    
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, name: "Peer" };

    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate });
    };

    // When we receive their video
    pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]);

    // Add our video to the call
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call-offer', { targetId, offer });
    
    renderUserList();
}

// Receiving a Call Offer
socket.on('incoming-call', async ({ from, name, offer }) => {
    if (!localStream) await startLocalMedia();
    
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[from] = { pc, name };

    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('call-ice', { targetId: from, candidate: e.candidate });
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
        try { callPeers[id].pc.close(); } catch (e) {}
    }
    delete callPeers[id];
    removeRemoteVideo(id);
    
    if (!isIncomingSignal) {
        socket.emit('call-end', { targetId: id });
    }
    renderUserList();
}


// ==========================================
// 10. WEBRTC SIGNALING (BROADCAST)
// ==========================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;

    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;

    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate });
    };

    // Determine which stream to send (Screen or Camera)
    const stream = isScreenSharing ? screenStream : localStream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

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


// ==========================================
// 11. SOCKET EVENTS & ROOM MANAGEMENT
// ==========================================

socket.on('connect', () => {
    $('signalStatus').className = 'status-dot status-connected';
    $('signalStatus').textContent = 'Connected';
    myId = socket.id;
});

socket.on('disconnect', () => {
    $('signalStatus').className = 'status-dot status-disconnected';
    $('signalStatus').textContent = 'Disconnected';
});

// Joining the Room
$('joinBtn').addEventListener('click', () => {
    const room = $('roomInput').value.trim();
    if (!room) return;

    currentRoom = room;
    userName = $('nameInput').value.trim() || 'Host';

    socket.connect();
    socket.emit('join-room', { room, name: userName });

    // UI Updates
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

// User Joined Event (With VIP Bouncer Logic)
socket.on('user-joined', ({ id, name }) => {
    
    // --- VIP BOUNCER CHECK ---
    if (iAmHost && isPrivateMode) {
        const isAllowed = allowedGuests.some(guest => guest.toLowerCase() === name.toLowerCase());
        if (!isAllowed) {
            console.log(`[Bouncer] Kicking ${name} - Not on guest list`);
            socket.emit('kick-user', id);
            return; // Stop here. Do not connect video.
        }
    }
    // -------------------------

    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    
    // If I am hosting a stream, connect video immediately
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

// Room Update (Lock status, Titles, User List)
socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users;
    currentOwnerId = ownerId;

    if (streamTitle && $('streamTitleInput')) {
        $('streamTitleInput').value = streamTitle;
    }

    if ($('lockRoomBtn')) {
        $('lockRoomBtn').textContent = locked ? 'Unlock Room' : 'Lock Room';
        $('lockRoomBtn').onclick = () => {
            if (iAmHost) socket.emit('lock-room', !locked);
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


// ==========================================
// 12. HOST CONTROLS (Title, Slug, VIP)
// ==========================================

if ($('updateTitleBtn')) {
    $('updateTitleBtn').addEventListener('click', () => {
        const title = $('streamTitleInput').value.trim();
        if (title) socket.emit('update-title', title);
    });
}

if ($('updateSlugBtn')) {
    $('updateSlugBtn').addEventListener('click', () => {
        const slug = $('slugInput').value.trim();
        if (slug) updateLink(slug);
    });
}

// VIP Bouncer UI Logic
const togglePrivateBtn = $('togglePrivateBtn');
const guestListPanel = $('guestListPanel');
const guestNameInput = $('guestNameInput');
const addGuestBtn = $('addGuestBtn');
const guestListDisplay = $('guestListDisplay');

if (togglePrivateBtn) {
    togglePrivateBtn.addEventListener('click', () => {
        isPrivateMode = !isPrivateMode;
        
        // Update UI
        togglePrivateBtn.textContent = isPrivateMode ? "ON" : "OFF";
        togglePrivateBtn.className = isPrivateMode ? "btn small danger" : "btn small secondary";
        guestListPanel.style.display = isPrivateMode ? "block" : "none";

        if (isPrivateMode) {
            // Immediately scan current users and kick unauthorized ones
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

if (addGuestBtn) {
    addGuestBtn.addEventListener('click', () => {
        const name = guestNameInput.value.trim();
        if (name && !allowedGuests.includes(name)) {
            allowedGuests.push(name);
            renderGuestList();
            guestNameInput.value = '';
        }
    });
}

function renderGuestList() {
    guestListDisplay.innerHTML = '';
    allowedGuests.forEach(name => {
        const tag = document.createElement('span');
        tag.style.cssText = "background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem;";
        tag.textContent = name;
        guestListDisplay.appendChild(tag);
    });
}


// ==========================================
// 13. CHAT SYSTEM (Secure & Emojis)
// ==========================================

function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';

    // SECURE CREATION (Prevent XSS)
    const s = document.createElement('strong'); 
    s.textContent = name;

    const t = document.createElement('small');
    t.textContent = new Date(ts).toLocaleTimeString();

    const txt = document.createTextNode(`: ${text}`);

    d.appendChild(s);
    d.appendChild(document.createTextNode(' '));
    d.appendChild(t);
    d.appendChild(txt);

    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

function sendPublic() {
    const inp = $('inputPublic');
    const text = inp.value.trim();
    if (!text || !currentRoom) return;
    
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPublic').addEventListener('click', sendPublic);
$('inputPublic').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendPublic(); });

function sendPrivate() {
    const inp = $('inputPrivate');
    const text = inp.value.trim();
    if (!text || !currentRoom) return;

    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
$('btnSendPrivate').addEventListener('click', sendPrivate);
$('inputPrivate').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendPrivate(); });

// Receive Socket Messages
socket.on('public-chat', d => {
    appendChat($('chatLogPublic'), d.name, d.text, d.ts);
    if (!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new');
});

socket.on('private-chat', d => {
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts);
    if (!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new');
});

// Emoji Click Logic
if ($('emojiStripPublic')) {
    $('emojiStripPublic').addEventListener('click', e => {
        if (e.target.classList.contains('emoji')) {
            $('inputPublic').value += e.target.textContent;
        }
    });
}
if ($('emojiStripPrivate')) {
    $('emojiStripPrivate').addEventListener('click', e => {
        if (e.target.classList.contains('emoji')) {
            $('inputPrivate').value += e.target.textContent;
        }
    });
}


// ==========================================
// 14. FILE SHARING TAB (Legacy)
// ==========================================

const fileInput = $('fileInput');
fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
        $('fileNameLabel').textContent = fileInput.files[0].name;
        $('sendFileBtn').disabled = false;
    }
});

$('sendFileBtn').addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file || !currentRoom) return;

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

socket.on('file-share', d => {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `<div><strong>${d.name}</strong> shared: ${d.fileName}</div><a href="${d.fileData}" download="${d.fileName}" class="btn small primary">Download</a>`;
    $('fileLog').appendChild(div);
    if (!tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ==========================================
// 15. ARCADE TAB (Input Logic)
// ==========================================

const arcadeInput = $('arcadeInput');
if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if (!file) return;

        activeToolboxFile = file;
        $('arcadeStatus').textContent = `Active Tool: ${file.name}`;

        // Sync to all current peers
        Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
    });
}


// ==========================================
// 16. USER LIST & UTILITIES
// ==========================================

function renderUserList() {
    const list = $('userList');
    list.innerHTML = '';

    latestUserList.forEach(u => {
        if (u.id === myId) return; // Don't list myself

        const div = document.createElement('div');
        div.className = 'user-item';

        const isCalling = !!callPeers[u.id];
        
        let actionBtn = isCalling
            ? `<button onclick="endPeerCall('${u.id}')" class="action-btn" style="border-color:var(--danger); color:var(--danger)">End Call</button>`
            : `<button onclick="ringUser('${u.id}')" class="action-btn">Call</button>`;

        const kickBtn = iAmHost
            ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>`
            : '';

        div.innerHTML = `<span>${u.id === currentOwnerId ? '👑' : ''} ${u.name}</span><div class="user-actions">${actionBtn}${kickBtn}</div>`;
        list.appendChild(div);
    });
}

// Helpers to add video elements dynamically
function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) {
        d = document.createElement('div');
        d.className = 'video-container';
        d.id = `vid-${id}`;
        d.innerHTML = `<video autoplay playsinline></video>`;
        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video');
    if (v.srcObject !== stream) v.srcObject = stream;
}

function removeRemoteVideo(id) {
    const el = document.getElementById(`vid-${id}`);
    if (el) el.remove();
}

// Make functions available globally for HTML onclick events
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

if ($('openStreamBtn')) {
    $('openStreamBtn').addEventListener('click', () => {
        const url = $('streamLinkInput').value;
        if (url) window.open(url, '_blank');
    });
}
