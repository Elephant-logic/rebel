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
let wasHost = false; // Track role transition for migration
let latestUserList = [];
let currentOwnerId = null;

// --- VIP BOUNCER STATE ---
let isPrivateMode = false;
let allowedGuests = [];
let mutedUsers = new Set(); // PATCH: Host-side global mute capability

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
let mixerLayout = 'SOLO'; // 'SOLO', 'GUEST', 'PIP', 'PIP_INVERTED', 'SPLIT'
let activeGuestId = null; // The ID of the guest currently selected for the mixer

// --- OVERLAY SIDE-LOADER STATE ---
let overlayActive = false;
let overlayImage = new Image();
let currentRawHTML = "";

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
            ctx.fillText("Waiting for Guest Signal...", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        // --- PATCH: DYNAMIC SPLIT (Scales with participant count) ---
        const participants = [];
        if (myVideo && myVideo.readyState === 4) participants.push(myVideo);
        
        Object.keys(callPeers).forEach(id => {
            const el = document.getElementById(`vid-${id}`);
            if (el && el.querySelector('video').readyState === 4) {
                participants.push(el.querySelector('video'));
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
        // ORIGINAL PIP: Host is Full, Guest is Small Thumbnail
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
        
        if (guestVideo && guestVideo.readyState === 4) {
            const pipW = 480, pipH = 270, padding = 30;
            const x = canvas.width - pipW - padding;
            const y = canvas.height - pipH - padding;
            ctx.strokeStyle = "#4af3a3"; ctx.lineWidth = 5;
            ctx.strokeRect(x, y, pipW, pipH);
            ctx.drawImage(guestVideo, x, y, pipW, pipH);
        }
    }
    else if (mixerLayout === 'PIP_INVERTED') {
        // INVERTED PIP: Guest is Full, Host is Small Thumbnail
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = '#111'; ctx.fillRect(0,0,canvas.width, canvas.height);
        }
        
        if (myVideo && myVideo.readyState === 4) {
            const pipW = 480, pipH = 270, padding = 30;
            const x = canvas.width - pipW - padding;
            const y = canvas.height - pipH - padding;
            ctx.strokeStyle = "#4af3a3"; ctx.lineWidth = 5;
            ctx.strokeRect(x, y, pipW, pipH);
            ctx.drawImage(myVideo, x, y, pipW, pipH);
        }
    }

    // --- 4. HTML OVERLAY LAYER ---
    // Paints the side-loaded layout on top of all screens
    if (overlayActive && overlayImage.complete) {
        ctx.drawImage(overlayImage, 0, 0, canvas.width, canvas.height);
    }

    // Loop
    requestAnimationFrame(drawMixer);
}

// Start the Mixer Engine
canvasStream = canvas.captureStream(30); // 30 FPS Broadcast Stream
drawMixer();

// --- NEW: HTML LAYOUT ENGINE ---
function renderHTMLLayout(htmlString) {
    if (!htmlString) return;
    currentRawHTML = htmlString;
    
    // Wrap HTML in a div that inherits the current mixer mode as a CSS class
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

// --- MIXER CONTROLS EXPOSED TO WINDOW ---
window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    console.log(`Mixer Layout: ${mode}`);
    
    // Update UI Buttons
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active');
        // Match buttons based on the mode argument passed to their onclick
        if (b.getAttribute('onclick').includes(`'${mode}'`)) {
            b.classList.add('active');
        }
    });

    // If an overlay is active, re-render it so it picks up the new layout class
    if (overlayActive) renderHTMLLayout(currentRawHTML);
};

window.setActiveGuest = (id) => {
    activeGuestId = id;
    console.log(`Guest ${id} selected for mixer.`);
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
    // If sharing screen, we don't want to kill the screen stream logic.
    if (isScreenSharing) {
        return; 
    }

    // Stop previous tracks
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    try {
        // --- 1. RESOLUTION LOGIC ---
        const quality = videoQuality ? videoQuality.value : 'ideal';
        let widthConstraint, heightConstraint;

        if (quality === 'max') {
             widthConstraint = { ideal: 1920 }; heightConstraint = { ideal: 1080 };
        } else if (quality === 'low') {
             widthConstraint = { ideal: 640 }; heightConstraint = { ideal: 360 };
        } else {
             widthConstraint = { ideal: 1280 }; heightConstraint = { ideal: 720 };
        }

        const constraints = {
            audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
            video: { 
                deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
                width: widthConstraint,
                height: heightConstraint
            }
        };

        const mainStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // --- 2. AUDIO MIXER LOGIC ---
        let finalAudioTrack = mainStream.getAudioTracks()[0];
        const secondaryId = audioSource2 ? audioSource2.value : null;

        if (secondaryId) {
            const secStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { deviceId: { exact: secondaryId } } 
            });
            
            if(!audioContext) audioContext = new AudioContext();
            audioDestination = audioContext.createMediaStreamDestination();

            const src1 = audioContext.createMediaStreamSource(mainStream);
            const src2 = audioContext.createMediaStreamSource(secStream);

            src1.connect(audioDestination);
            src2.connect(audioDestination);

            finalAudioTrack = audioDestination.stream.getAudioTracks()[0];
        }

        // --- 3. SET LOCAL STREAM ---
        localStream = new MediaStream([
            mainStream.getVideoTracks()[0], 
            finalAudioTrack
        ]);
        
        // Set local video element (Host Preview)
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; // Mute to prevent echo

        // --- 4. UPDATE VIEWERS (BROADCAST) ---
        const mixedVideoTrack = canvasStream.getVideoTracks()[0];

        const updateViewerPC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            
            // Replace Video Track with MIXER Track
            const vSender = senders.find(s => s.track && s.track.kind === 'video');
            if (vSender) vSender.replaceTrack(mixedVideoTrack);
            
            // Replace Audio Track with MIXED AUDIO Track
            const aSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (aSender) aSender.replaceTrack(finalAudioTrack);
        };

        // Update all connected Broadcast Viewers
        Object.values(viewerPeers).forEach(updateViewerPC);
        
        // Update 1:1 Callers (Guests)
        Object.values(callPeers).forEach(p => {
             const senders = p.pc.getSenders();
             const vSender = senders.find(s => s.track && s.track.kind === 'video');
             // Send RAW camera to the guest, so they see you clearly
             if(vSender) vSender.replaceTrack(mainStream.getVideoTracks()[0]);
             
             // Send Mixed Audio
             const aSender = senders.find(s => s.track && s.track.kind === 'audio');
             if(aSender) aSender.replaceTrack(finalAudioTrack);
        });

        // Enable UI
        $('hangupBtn').disabled = false;
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
// 7. SCREEN SHARING LOGIC
// ======================================================

if ($('shareScreenBtn')) {
    $('shareScreenBtn').addEventListener('click', async () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                isScreenSharing = true;
                
                // Update Button UI
                $('shareScreenBtn').textContent = 'Stop Screen';
                $('shareScreenBtn').classList.add('danger');
                
                // Show screen locally in the 'You' box
                $('localVideo').srcObject = screenStream;
                
                // *** FIX: Send Screen to All Peers (Guests) ***
                const screenTrack = screenStream.getVideoTracks()[0];
                const screenAudio = screenStream.getAudioTracks()[0]; // Capture system audio

                Object.values(callPeers).forEach(p => {
                    p.pc.getSenders().forEach(s => {
                        if(s.track.kind === 'video') s.replaceTrack(screenTrack);
                        if(screenAudio && s.track.kind === 'audio') s.replaceTrack(screenAudio);
                    });
                });
                
                // Handle native "Stop Sharing" bar
                screenTrack.onended = stopScreenShare;

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

// PATCH: NO AUTO-START ON JOIN
async function handleStartStream() {
    if (!currentRoom || !iAmHost) return;
    if (!localStream) await startLocalMedia();
    
    isStreaming = true;
    if ($('startStreamBtn')) {
        $('startStreamBtn').textContent = "Stop Stream"; 
        $('startStreamBtn').classList.add('danger');
    }
    
    // Connect to every user currently in the list
    latestUserList.forEach(u => { 
        if (u.id !== myId) {
            connectViewer(u.id); 
        }
    });
}

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
            await handleStartStream();
        }
    });
}


// ======================================================
// 9. P2P CALLING (1-to-1)
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
// 10. VIEWER CONNECTION & ARCADE PUSH (CRITICAL FIX)
// ======================================================
async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    const controlChannel = pc.createDataChannel("control");
    controlChannel.onopen = () => console.log(`Control channel open for ${targetId}`);

    pc.onicecandidate = e => { 
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); 
        }
    };
    
    // --- SEND MIXED CANVAS STREAM ---
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    
    // Add Audio (From the local mixed stream)
    if(localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if(audioTrack) pc.addTrack(audioTrack, canvasStream);
    }
    
    // --- ARCADE AUTO-PUSH ---
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
// 11. SOCKET & ROOM LOGIC
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
    
    // --- VIP BOUNCER CHECK ---
    if (iAmHost && isPrivateMode) {
        const isAllowed = allowedGuests.some(g => g.toLowerCase() === name.toLowerCase());
        if (!isAllowed) {
            socket.emit('kick-user', id);
            return; 
        }
    }

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
    
    if (streamTitle && $('streamTitleInput')) {
        $('streamTitleInput').value = streamTitle;
        updateLink($('roomInput').value || currentRoom);
    }

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

// PATCH: AUTHORITY ENFORCEMENT (NO AUTO-TAKEOVER FOR VIEWERS)
socket.on('role', async ({ isHost }) => {
    wasHost = iAmHost; 
    iAmHost = isHost;
    
    if ($('localContainer')) {
        $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    }
    if ($('hostControls')) $('hostControls').style.display = isHost ? 'block' : 'none';
    
    renderUserList();
});


// ======================================================
// 12. HOST CONTROLS (TITLE, SLUG, VIP)
// ======================================================

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
        
        $('togglePrivateBtn').textContent = isPrivateMode ? "ON" : "OFF";
        $('togglePrivateBtn').className = isPrivateMode ? "btn small danger" : "btn small secondary";
        if ($('guestListPanel')) $('guestListPanel').style.display = isPrivateMode ? "block" : "none";
        
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
    if (!display) return;
    display.innerHTML = '';
    allowedGuests.forEach(name => {
        const tag = document.createElement('span');
        tag.style.cssText = "background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem;";
        tag.textContent = name;
        display.appendChild(tag);
    });
}


// ======================================================
// 13. CHAT SYSTEM (Public/Private/Emojis)
// ======================================================

function appendChat(log, name, text, ts) {
    if (!log) return;
    const d = document.createElement('div');
    d.className = 'chat-line';
    
    // Secure Elements (No InnerHTML - Anti-XSS)
    const s = document.createElement('strong'); s.textContent = name;
    const t = document.createElement('small'); t.textContent = new Date(ts).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    
    d.appendChild(s); d.appendChild(document.createTextNode(' ')); d.appendChild(t); d.appendChild(txt);
    log.appendChild(d); log.scrollTop = log.scrollHeight;
}

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

// Receive Socket Messages
socket.on('public-chat', d => { 
    // PATCH: HOST LOCAL MUTE FILTER
    if (mutedUsers.has(d.name)) return;
    appendChat($('chatLogPublic'), d.name, d.text, d.ts); 
    if(tabs.stream && !tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); 
});
socket.on('private-chat', d => { 
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts); 
    if(tabs.room && !tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); 
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
// 14. FILE SHARING TAB (Document sharing)
// ======================================================

const fileInput = $('fileInput');
if (fileInput) {
    fileInput.addEventListener('change', () => { 
        if(fileInput.files.length) { 
            $('fileNameLabel').textContent = fileInput.files[0].name; 
            $('sendFileBtn').disabled = false; 
        } 
    });
}

if ($('sendFileBtn')) {
    $('sendFileBtn').addEventListener('click', () => {
        const file = fileInput.files[0];
        
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
}

// SECURE RENDERING (No InnerHTML)
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
    
    if ($('fileLog')) $('fileLog').appendChild(div);
    if(tabs.files && !tabs.files.classList.contains('active')) tabs.files.classList.add('has-new');
});


// ======================================================
// 15. ARCADE & HTML LAYOUT SIDE-LOADER
// ======================================================

const arcadeInput = $('arcadeInput');
if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if(!file) return;
        
        activeToolboxFile = file;
        $('arcadeStatus').textContent = `Active Tool: ${file.name}`;
        
        let resendBtn = document.getElementById('resendToolBtn');
        if(!resendBtn) {
            resendBtn = document.createElement('button');
            resendBtn.id = 'resendToolBtn';
            resendBtn.textContent = 'Force Resend Tool';
            resendBtn.className = 'btn small secondary full-width';
            resendBtn.style.marginTop = '5px';
            resendBtn.onclick = () => {
                Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, activeToolboxFile));
                alert("Tool resent to all connected viewers.");
            };
            $('arcadeStatus').parentNode.appendChild(resendBtn);
        }
        
        Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file));
    });
}

// --- NEW: HTML LAYOUT SIDE-LOADER ---
const htmlOverlayInput = $('htmlOverlayInput');
if (htmlOverlayInput) {
    htmlOverlayInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => renderHTMLLayout(event.target.result);
        reader.readAsText(file);
    });
}

window.clearOverlay = () => { 
    overlayActive = false; 
    overlayImage = new Image(); 
    if($('overlayStatus')) $('overlayStatus').textContent = "[Empty]";
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
        
        // PATCH: HOST LOCAL MUTE BUTTON
        if (iAmHost) {
            const mBtn = document.createElement('button');
            mBtn.className = 'action-btn';
            mBtn.textContent = mutedUsers.has(u.name) ? 'Unmute Chat' : 'Mute Chat';
            mBtn.onclick = () => {
                if(mutedUsers.has(u.name)) mutedUsers.delete(u.name);
                else mutedUsers.add(u.name);
                renderUserList();
            };
            actionsDiv.appendChild(mBtn);
        }

        // CALL BUTTON
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

        // MIXER SELECT BUTTON
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
        
        // MANUAL PROMOTION BUTTON
        if (iAmHost) {
            const promoteBtn = document.createElement('button');
            promoteBtn.className = 'action-btn';
            promoteBtn.style.borderColor = 'var(--accent)';
            promoteBtn.textContent = '👑 Promote';
            promoteBtn.onclick = () => {
                if(confirm(`Hand over Host control to ${u.name}?`)) {
                    socket.emit('promote-to-host', { targetId: u.id });
                }
            };
            actionsDiv.appendChild(promoteBtn);
            
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
        d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`;
        
        const v = document.createElement('video');
        v.autoplay = true;
        v.playsInline = true;
        d.appendChild(v);

        const h2 = document.createElement('h2');
        h2.textContent = callPeers[id] ? callPeers[id].name : "Guest";
        d.appendChild(h2);

        if ($('videoGrid')) $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); if(v.srcObject !== stream) v.srcObject = stream;
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
