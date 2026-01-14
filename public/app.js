// =======================================================================
// =======================================================================
//
//        REBEL STREAM - MONSTER APPLICATION (HOST & GUEST CLIENT)
//
// =======================================================================
// =======================================================================
//
//  This application handles the complete broadcasting, communication,
//  and data transfer suite for the Rebel Stream platform.
//
//  CORE SYSTEMS:
//  1. P2P Data Engine: Transfer Arcade Tools & Chat Files via WebRTC.
//  2. Canvas Video Mixer: Composites Cameras, Screens, and Overlays.
//  3. Audio Mixer: Merges Microphone, System Audio, and Music.
//  4. WebRTC Signaling: Manages Broadcasting (One-Way) & Calls (Two-Way).
//  5. Room Management: Admin Controls, Banning, Locking, and Links.
//
// =======================================================================

console.log("Rebel Stream Monster App Loaded - FINAL VERBOSE VERSION"); 

// =======================================================================
// ------------------------- CONFIGURATION -------------------------------
// =======================================================================

// 16KB is the safe chunk size for WebRTC SCTP Data Channels.
// Anything larger risks packet loss or browser disconnects.
const CHUNK_SIZE = 16 * 1024; 

// 256KB Buffer Limit prevents the browser process from crashing
// by flooding the network card with too much data at once.
const MAX_BUFFER = 256 * 1024; 

// ICE Servers (STUN/TURN) Configuration
// Uses Google's public STUN by default, or custom servers if provided.
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };


// =======================================================================
// --------------------------- DOM HELPER --------------------------------
// =======================================================================

/**
 * Shorthand for document.getElementById
 * @param {string} id - The element ID
 * @returns {HTMLElement} - The DOM element
 */
const $ = (id) => {
    return document.getElementById(id);
};


// =======================================================================
// ------------------------ GLOBAL VARIABLES -----------------------------
// =======================================================================

// Initialize Socket.io (Manual connection for better control)
const socket = io({ autoConnect: false });

// --- USER STATE ---
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
let isScreenSharing = false;
let isStreaming = false; // Indicates if the "Broadcast" is active

// --- ARCADE / FILE STATE ---
let activeToolboxFile = null;

// --- MIXER STATE (CANVAS ENGINE) ---
let audioContext = null;
let audioDestination = null;

// The Canvas is the heart of the broadcast.
// All video sources are painted onto this, and this is what viewers see.
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 

let mixerLayout = 'SOLO'; // 'SOLO', 'GUEST', 'PIP', 'SPLIT'
let activeGuestId = null; 

// --- CONNECTION MAPS ---
// Viewers: People watching the stream (Receive Arcade)
const viewerPeers = {}; 

// Call Peers: People in a 2-way call (Receive Files)
const callPeers = {};   


// =======================================================================
// =======================================================================
//
//            1. P2P DATA TRANSFER ENGINE (FIXED & UNIFIED)
//
// =======================================================================
// =======================================================================

/**
 * Universal function to send data to a specific peer.
 * Handles both 'arcade' (Tools) and 'file' (Chat Download).
 * * @param {RTCPeerConnection} pc - The target connection
 * @param {File} file - The file object to send
 * @param {string} type - 'arcade' or 'file'
 * @param {function} onProgress - Optional callback for UI bars
 */
async function pushFileToPeer(pc, file, type = 'arcade', onProgress) {
    if (!pc) {
        return; // No connection, abort.
    }

    // Determine the channel label based on the data type.
    // 'side-load-pipe' -> Auto-launches as an Arcade Tool
    // 'transfer-pipe'  -> Appears as a File Download in Chat
    const label = (type === 'arcade') ? 'side-load-pipe' : 'transfer-pipe';

    // Create a unique data channel for this specific file transfer
    const channel = pc.createDataChannel(label);

    channel.onopen = async () => {
        console.log(`[P2P] Starting transfer: ${file.name} [Type: ${type}]`);

        // 1. Send Metadata (First Message)
        // This tells the receiver what is coming so they can prepare.
        const metadata = JSON.stringify({
            dataType: type,
            name: file.name,
            size: file.size,
            mime: file.type
        });
        channel.send(metadata);

        // 2. Read the File into memory (ArrayBuffer)
        const buffer = await file.arrayBuffer();
        let offset = 0;

        // 3. Send Loop (Recursive with Timeout for Flow Control)
        const sendLoop = () => {
            // Flow Control:
            // If the browser's buffer is full, wait 10ms and try again.
            // This prevents the connection from crashing.
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }

            // Stop if the channel closed unexpectedly
            if (channel.readyState !== 'open') {
                return;
            }

            // Slice a 16KB chunk from the buffer
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;

            // Calculate and Report Progress
            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            // Determine next step
            if (offset < buffer.byteLength) {
                // More data to send -> Schedule next chunk immediately
                setTimeout(sendLoop, 0); 
            } else {
                // Transfer Complete
                console.log(`[P2P] Transfer of ${file.name} Complete.`);
                
                // Close the channel gracefully after a short delay
                setTimeout(() => {
                    channel.close();
                }, 1000);
            }
        };

        // Start the transmission loop
        sendLoop();
    };
}

/**
 * Listens for incoming data on a peer connection.
 * Used by Host and Guests to receive files or arcade tools.
 */
function setupDataReceiver(pc, peerId) {
    pc.ondatachannel = (e) => {
        const chan = e.channel;
        
        // Security Filter: Only accept valid transfer channels
        if (chan.label !== "transfer-pipe" && chan.label !== "side-load-pipe") {
            return; 
        }

        // *** CRITICAL FIX: Ensure Binary Type is ArrayBuffer ***
        // Without this line, some browsers (like Chrome) treat incoming data
        // as 'Blob' objects, which breaks the chunk assembly logic.
        chan.binaryType = 'arraybuffer';

        let chunks = [];
        let total = 0;
        let curr = 0;
        let meta = null;

        chan.onmessage = (evt) => {
            const data = evt.data;
            
            // A. Handle Metadata (First Message is typically a JSON string)
            if (typeof data === 'string') {
                try { 
                    meta = JSON.parse(data); 
                    total = meta.size; 
                } catch(e) {
                    console.error("Failed to parse metadata", e);
                }
            } 
            // B. Handle Binary Data (Subsequent Messages are ArrayBuffers)
            else {
                chunks.push(data); 
                curr += data.byteLength;
                
                // Check if transfer is complete
                if (curr >= total) {
                    // Reassemble the file blob
                    const blob = new Blob(chunks, { type: meta ? meta.mime : 'application/octet-stream' });
                    const url = URL.createObjectURL(blob);
                    
                    // --- ROUTING LOGIC ---
                    
                    if (meta && meta.dataType === 'file') {
                        // CASE 1: Chat File
                        // Show a download card in the private chat
                        const senderName = (callPeers[peerId] && callPeers[peerId].name) ? callPeers[peerId].name : "Guest";
                        addFileToChat(senderName, meta.name, url);
                    }
                    else if (meta && meta.dataType === 'arcade') {
                        // CASE 2: Arcade Tool
                        // Log reception (The View.html page handles the actual execution)
                        console.log("Arcade Tool Received via P2P:", meta.name);
                    }

                    // Clean up resources
                    chan.close();
                }
            }
        };
    };
}

/**
 * Creates a visual download card in the Private Chat window.
 */
function addFileToChat(senderName, fileName, url) {
    const log = $('chatLogPrivate');
    if (!log) return;

    const div = document.createElement('div');
    div.className = 'chat-line system-msg';
    
    // Create the HTML structure for the file card
    // Includes a styled download button
    div.innerHTML = `
        <div style="background: rgba(255,255,255,0.05); border: 1px solid #4af3a3; padding: 10px; border-radius: 8px; margin: 8px 0;">
            <div style="font-size:0.8rem; color:#aaa;">${senderName} shared:</div>
            <div style="color:#fff; font-weight:bold; margin: 4px 0;">${fileName}</div>
            <a href="${url}" download="${fileName}" class="btn small primary" style="text-decoration:none; display:inline-block;">
                ⬇️ Download
            </a>
        </div>
    `;
    
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    
    // Add Notification Badge to Tab if not currently active
    if (!tabs.room.classList.contains('active')) {
        tabs.room.classList.add('has-new');
    }
}


// =======================================================================
// =======================================================================
//
//                  2. CANVAS MIXER ENGINE
//
// =======================================================================
// =======================================================================

function drawMixer() {
    if (!ctx) return;
    
    // 1. Clear Background (Set to Black)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Get Video Sources
    const myVideo = $('localVideo');
    let guestVideo = null;
    
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`);
        if (el) {
            guestVideo = el.querySelector('video');
        }
    }

    // 3. Draw Layout based on current mode
    
    // --- MODE: SOLO (Host Only) ---
    if (mixerLayout === 'SOLO') {
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
    } 
    
    // --- MODE: GUEST (Guest Only) ---
    else if (mixerLayout === 'GUEST') {
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        } else {
            // Placeholder text if no guest video is available
            ctx.fillStyle = '#333'; 
            ctx.fillRect(0,0,canvas.width, canvas.height);
            ctx.fillStyle = '#fff'; 
            ctx.font = "60px Arial"; 
            ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest...", canvas.width/2, canvas.height/2);
        }
    }
    
    // --- MODE: SPLIT (Side-by-Side) ---
    else if (mixerLayout === 'SPLIT') {
        // 16:9 Letterboxed Split (Host Left, Guest Right)
        const slotW = 960; 
        const vidH = 540; 
        const yOffset = (1080 - vidH) / 2;

        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, yOffset, slotW, vidH);
        }
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 960, yOffset, slotW, vidH);
        }
        
        // Draw Divider Line
        ctx.strokeStyle = '#222'; 
        ctx.lineWidth = 4;
        ctx.beginPath(); 
        ctx.moveTo(960, 0); 
        ctx.lineTo(960, 1080); 
        ctx.stroke();
    }
    
    // --- MODE: PIP (Picture-In-Picture) ---
    else if (mixerLayout === 'PIP') {
        // Host Base (Full Screen)
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
        // Guest Overlay (Bottom Right)
        if (guestVideo && guestVideo.readyState === 4) {
            const pipW = 480; 
            const pipH = 270; 
            const padding = 30;
            const x = canvas.width - pipW - padding; 
            const y = canvas.height - pipH - padding;
            
            // Draw Border
            ctx.strokeStyle = "#4af3a3"; 
            ctx.lineWidth = 5; 
            ctx.strokeRect(x, y, pipW, pipH);
            
            // Draw Video
            ctx.drawImage(guestVideo, x, y, pipW, pipH);
        }
    }

    // Loop (30 FPS approximation via requestAnimationFrame)
    requestAnimationFrame(drawMixer);
}

// Initialize Mixer
canvasStream = canvas.captureStream(30);
drawMixer();

// --- EXPOSED CONTROLS ---
window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    
    // Update UI Buttons (Visual Feedback)
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active');
        if (b.textContent.toUpperCase().includes(mode) || (mode==='PIP' && b.textContent.includes('Overlay'))) {
            b.classList.add('active');
        }
    });
};

window.setActiveGuest = (id) => {
    activeGuestId = id;
    alert(`Guest Selected! Switch to 'Overlay' or 'Split' to view.`);
};


// =======================================================================
// =======================================================================
//
//                  3. TAB NAVIGATION
//
// =======================================================================
// =======================================================================

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
    
    // Deactivate all
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));
    
    // Activate selected
    tabs[name].classList.add('active'); 
    contents[name].classList.add('active');
    
    // Clear notification badge
    tabs[name].classList.remove('has-new');
}

// Bind Click Listeners
Object.keys(tabs).forEach(k => { 
    if(tabs[k]) {
        tabs[k].onclick = () => switchTab(k); 
    }
});


// =======================================================================
// =======================================================================
//
//                  4. DEVICE SETTINGS
//
// =======================================================================
// =======================================================================

const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); 
const videoSource = $('videoSource');
const videoQuality = $('videoQuality');

if ($('settingsBtn')) {
    $('settingsBtn').onclick = () => {
        const isHidden = settingsPanel.style.display === 'none' || settingsPanel.style.display === '';
        settingsPanel.style.display = isHidden ? 'block' : 'none';
        if (isHidden) getDevices();
    };
}

if ($('closeSettingsBtn')) {
    $('closeSettingsBtn').onclick = () => {
        settingsPanel.style.display = 'none';
    };
}

async function getDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        audioSource.innerHTML = ''; 
        videoSource.innerHTML = '';
        if(audioSource2) audioSource2.innerHTML = '<option value="">-- None --</option>';

        devices.forEach(d => {
            const opt = document.createElement('option'); 
            opt.value = d.deviceId; 
            opt.text = d.label || d.kind;
            
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
                if(audioSource2) audioSource2.appendChild(opt.cloneNode(true));
            }
            if (d.kind === 'videoinput') {
                videoSource.appendChild(opt);
            }
        });
        
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

// Setup Change Listeners to restart media on change
audioSource.onchange = startLocalMedia;
if(audioSource2) audioSource2.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;
if(videoQuality) videoQuality.onchange = startLocalMedia;


// =======================================================================
// =======================================================================
//
//                  5. MEDIA CONTROLS
//
// =======================================================================
// =======================================================================

async function startLocalMedia() {
    // If screen sharing is active, we don't want to override it with the camera
    if (isScreenSharing) return;
    
    // Stop existing tracks
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    try {
        const quality = videoQuality ? videoQuality.value : 'ideal';
        let widthConstraint, heightConstraint;

        if (quality === 'max') { 
            widthConstraint = { ideal: 1920 }; heightConstraint = { ideal: 1080 }; 
        } 
        else if (quality === 'low') { 
            widthConstraint = { ideal: 640 }; heightConstraint = { ideal: 360 }; 
        } 
        else { 
            widthConstraint = { ideal: 1280 }; heightConstraint = { ideal: 720 }; 
        }

        const mainStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: audioSource.value ? { exact: audioSource.value } : undefined },
            video: { 
                deviceId: videoSource.value ? { exact: videoSource.value } : undefined, 
                width: widthConstraint, 
                height: heightConstraint 
            }
        });

        let finalAudioTrack = mainStream.getAudioTracks()[0];
        const secondaryId = audioSource2 ? audioSource2.value : null;

        // --- AUDIO MIXING LOGIC ---
        // If a secondary mic is selected, mix it with the main mic
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

        localStream = new MediaStream([mainStream.getVideoTracks()[0], finalAudioTrack]);
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; // Mute local preview to avoid feedback

        // --- UPDATE ACTIVE CONNECTIONS ---
        
        // 1. Update Broadcast (Viewers get Mixer)
        const mixedVideoTrack = canvasStream.getVideoTracks()[0];
        Object.values(viewerPeers).forEach(pc => {
            pc.getSenders().forEach(s => {
                if (s.track.kind === 'video') s.replaceTrack(mixedVideoTrack);
                if (s.track.kind === 'audio') s.replaceTrack(finalAudioTrack);
            });
        });
        
        // 2. Update Calls (Guests get Raw Camera)
        Object.values(callPeers).forEach(p => {
             p.pc.getSenders().forEach(s => {
                 if(s.track.kind === 'video') s.replaceTrack(mainStream.getVideoTracks()[0]);
                 if(s.track.kind === 'audio') s.replaceTrack(finalAudioTrack);
             });
        });

        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { 
        console.error(e); 
        alert("Camera access failed. Check permissions."); 
    }
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

if ($('toggleMicBtn')) {
    $('toggleMicBtn').onclick = () => { 
        if (localStream) { 
            const t = localStream.getAudioTracks()[0]; 
            if(t) { 
                t.enabled = !t.enabled; 
                updateMediaButtons(); 
            } 
        } 
    };
}

if ($('toggleCamBtn')) {
    $('toggleCamBtn').onclick = () => { 
        if (localStream) { 
            const t = localStream.getVideoTracks()[0]; 
            if(t) { 
                t.enabled = !t.enabled; 
                updateMediaButtons(); 
            } 
        } 
    };
}


// =======================================================================
// =======================================================================
//
//                  6. SCREEN SHARING
//
// =======================================================================
// =======================================================================

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
                const screenAudio = screenStream.getAudioTracks()[0];
                
                // Update all peers with screen track
                Object.values(callPeers).forEach(p => {
                    p.pc.getSenders().forEach(s => {
                        if(s.track.kind === 'video') s.replaceTrack(screenTrack);
                        if(screenAudio && s.track.kind === 'audio') s.replaceTrack(screenAudio);
                    });
                });

                // Listen for native stop button
                screenStream.getVideoTracks()[0].onended = stopScreenShare;
            } catch(e) { 
                console.error(e); 
            }
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
    }
    
    screenStream = null;
    isScreenSharing = false;
    
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    
    // Return to camera
    startLocalMedia();
}


// =======================================================================
// =======================================================================
//
//                  7. BROADCASTING (Host -> Viewers)
//
// =======================================================================
// =======================================================================

if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) return alert("Host only functionality.");
        
        if (isStreaming) {
            // STOP STREAMING
            isStreaming = false;
            $('startStreamBtn').textContent = "Start Stream";
            $('startStreamBtn').classList.remove('danger');
            
            // Disconnect all viewers
            Object.values(viewerPeers).forEach(pc => pc.close());
            for (const k in viewerPeers) delete viewerPeers[k];
        } else {
            // START STREAMING
            if (!localStream) await startLocalMedia();
            isStreaming = true;
            $('startStreamBtn').textContent = "Stop Stream"; 
            $('startStreamBtn').classList.add('danger');
            
            // Connect to everyone in the room
            latestUserList.forEach(u => { 
                if (u.id !== myId) connectViewer(u.id); 
            });
        }
    });
}


// =======================================================================
// =======================================================================
//
//                  8. P2P CALLING (Host <-> Guests)
//
// =======================================================================
// =======================================================================

if ($('hangupBtn')) {
    $('hangupBtn').onclick = () => Object.keys(callPeers).forEach(id => endPeerCall(id));
}

socket.on('ring-alert', async ({ from, fromId }) => { 
    if (confirm(`Call from ${from}?`)) {
        await callPeer(fromId); 
    }
});

async function callPeer(targetId) {
    if (!localStream) await startLocalMedia();
    
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[targetId] = { pc, name: "Peer" };
    
    // *** LISTEN FOR FILES FROM THIS PEER ***
    setupDataReceiver(pc, targetId); 

    pc.onicecandidate = e => { 
        if (e.candidate) socket.emit('call-ice', { targetId, candidate: e.candidate }); 
    };
    
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
    
    // *** LISTEN FOR FILES FROM THIS PEER ***
    setupDataReceiver(pc, from); 

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

socket.on('call-end', ({ from }) => endPeerCall(from, true));

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


// =======================================================================
// =======================================================================
//
//                  9. VIEWER CONNECTION (One-Way)
//
// =======================================================================
// =======================================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    // Force Data Channel for Arcade Control
    const dc = pc.createDataChannel("control");

    pc.onicecandidate = e => { 
        if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); 
    };
    
    // Send Canvas Stream
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    
    // Send Audio (if available)
    if(localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if(audioTrack) pc.addTrack(audioTrack, canvasStream);
    }
    
    // --- ARCADE AUTO-PUSH ---
    // If a tool is loaded, send it to the new viewer immediately
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing tool to ${targetId}`);
        // Delay to allow ICE to settle
        setTimeout(() => {
            pushFileToPeer(pc, activeToolboxFile, 'arcade'); 
        }, 1000);
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


// =======================================================================
// =======================================================================
//
//                  10. SOCKET EVENTS
//
// =======================================================================
// =======================================================================

socket.on('connect', () => { 
    $('signalStatus').className = 'status-dot status-connected'; 
    $('signalStatus').textContent = 'Connected'; 
    myId = socket.id; 
});

socket.on('disconnect', () => { 
    $('signalStatus').className = 'status-dot status-disconnected'; 
    $('signalStatus').textContent = 'Disconnected'; 
});

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

if ($('leaveBtn')) {
    $('leaveBtn').addEventListener('click', () => window.location.reload());
}

function updateLink(roomSlug) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace('index.html', '') + 'view.html';
    url.search = `?room=${encodeURIComponent(roomSlug)}`;
    $('streamLinkInput').value = url.toString();
}

socket.on('user-joined', ({ id, name }) => {
    // VIP Bouncer Logic
    if (iAmHost && isPrivateMode && !allowedGuests.some(g => g.toLowerCase() === name.toLowerCase())) {
        socket.emit('kick-user', id); 
        return;
    }
    
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

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users; 
    currentOwnerId = ownerId;
    
    if (streamTitle && $('streamTitleInput')) {
        $('streamTitleInput').value = streamTitle;
    }
    
    if ($('lockRoomBtn')) { 
        $('lockRoomBtn').textContent = locked ? 'Unlock Room' : 'Lock Room'; 
        $('lockRoomBtn').onclick = () => { 
            if(iAmHost) socket.emit('lock-room', !locked); 
        }; 
    }
    renderUserList();
});

socket.on('role', ({ isHost }) => {
    iAmHost = isHost;
    if($('localContainer')) {
        $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    }
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});


// =======================================================================
// =======================================================================
//
//                  11. CONTROLS (Chat, Files, Admin)
//
// =======================================================================
// =======================================================================

// --- HELPER: Generate Breakout Room Link ---
function generateRoomLink() {
    const id = 'room-' + Math.random().toString(36).substring(2, 9);
    const link = window.location.origin + window.location.pathname + '?room=' + id;
    return { id, link };
}

if ($('updateTitleBtn')) {
    $('updateTitleBtn').onclick = () => socket.emit('update-stream-title', $('streamTitleInput').value.trim());
}
if ($('updateSlugBtn')) {
    $('updateSlugBtn').onclick = () => updateLink($('slugInput').value.trim());
}

if ($('togglePrivateBtn')) {
    $('togglePrivateBtn').onclick = () => {
        isPrivateMode = !isPrivateMode;
        $('togglePrivateBtn').textContent = isPrivateMode ? "ON" : "OFF";
        $('togglePrivateBtn').className = isPrivateMode ? "btn small danger" : "btn small secondary";
        $('guestListPanel').style.display = isPrivateMode ? "block" : "none";
        
        if (isPrivateMode) {
            latestUserList.forEach(u => { 
                if(u.id !== myId && !allowedGuests.some(g=>g.toLowerCase() === u.name.toLowerCase())) {
                    socket.emit('kick-user', u.id); 
                }
            });
        }
    };
}

if ($('addGuestBtn')) {
    $('addGuestBtn').onclick = () => { 
        const val = $('guestNameInput').value.trim(); 
        if(val && !allowedGuests.includes(val)) { 
            allowedGuests.push(val); 
            renderGuestList(); 
            $('guestNameInput').value=''; 
        } 
    };
}

function renderGuestList() { 
    $('guestListDisplay').innerHTML = ''; 
    allowedGuests.forEach(n => { 
        const s = document.createElement('span'); 
        s.textContent = n; 
        s.style.cssText="background:var(--accent);color:#000;padding:2px 6px;border-radius:4px;font-size:0.7rem;"; 
        $('guestListDisplay').appendChild(s); 
    }); 
}

function appendChat(log, name, text, ts) {
    const d = document.createElement('div'); 
    d.className = 'chat-line';
    d.innerHTML = `<strong>${name}</strong> <small>${new Date(ts).toLocaleTimeString()}</small>: ${text.replace(/</g, "&lt;")}`;
    log.appendChild(d); 
    log.scrollTop = log.scrollHeight;
}

function sendChat(type) {
    const inp = $(type === 'public' ? 'inputPublic' : 'inputPrivate'); 
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    
    socket.emit(`${type}-chat`, { room: currentRoom, name: userName, text }); 
    inp.value = '';
}

$('btnSendPublic').onclick = () => sendChat('public'); 
$('inputPublic').onkeydown = e => { if(e.key==='Enter') sendChat('public'); };

$('btnSendPrivate').onclick = () => sendChat('private'); 
$('inputPrivate').onkeydown = e => { if(e.key==='Enter') sendChat('private'); };

socket.on('public-chat', d => { 
    appendChat($('chatLogPublic'), d.name, d.text, d.ts); 
    if(!tabs.stream.classList.contains('active')) tabs.stream.classList.add('has-new'); 
});

socket.on('private-chat', d => { 
    appendChat($('chatLogPrivate'), d.name, d.text, d.ts); 
    if(!tabs.room.classList.contains('active')) tabs.room.classList.add('has-new'); 
});

if ($('emojiStripPublic')) {
    $('emojiStripPublic').onclick = e => { 
        if(e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; 
    };
}
if ($('emojiStripPrivate')) {
    $('emojiStripPrivate').onclick = e => { 
        if(e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; 
    };
}


// =======================================================================
// =======================================================================
//
//            12. FILES & ARCADE (UNIFIED P2P + ROOM LINKS)
//
// =======================================================================
// =======================================================================

// --- A. CHAT FILE SHARING ---
const fileInput = $('fileInput');
if (fileInput) {
    fileInput.addEventListener('change', () => { 
        if(fileInput.files.length) { 
            $('fileNameLabel').textContent = fileInput.files[0].name; 
            $('sendFileBtn').disabled = false; 
        } 
    });

    $('sendFileBtn').addEventListener('click', () => {
        const file = fileInput.files[0];
        if(!file) return;
        
        // Use P2P to send to connected guests (Room)
        const guests = Object.values(callPeers);
        
        if(guests.length === 0) {
            alert("No guests connected to share this file with. You must be in a call.");
            return;
        }
        
        // Generate Breakout Room Link
        const { link } = generateRoomLink();
        
        guests.forEach(p => {
            pushFileToPeer(p.pc, file, 'file', (pct) => {
                $('fileNameLabel').textContent = `Sending: ${pct}%`;
                if(pct >= 100) $('fileNameLabel').textContent = "Sent!";
            });
        });

        // Add confirmation to own chat
        addFileToChat("You", file.name, URL.createObjectURL(file));
        
        // Share Breakout Link in Private Chat
        socket.emit('private-chat', { 
            room: currentRoom, 
            name: "System", 
            text: `Files shared. Breakout Room created: ${link}` 
        });

        fileInput.value = ''; 
        $('sendFileBtn').disabled = true;
    });
}

// --- B. ARCADE TOOL SHARING ---
const arcadeInput = $('arcadeInput');
if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if(!file) return;
        
        activeToolboxFile = file;
        $('arcadeStatus').textContent = `Active: ${file.name}`;
        
        // Generate Breakout Room Link
        const { link } = generateRoomLink();
        
        // Add Resend Button
        let btn = document.getElementById('resendToolBtn');
        if(!btn) {
            btn = document.createElement('button'); 
            btn.id = 'resendToolBtn';
            btn.textContent = 'Force Resend'; 
            btn.className = 'btn small secondary full-width'; 
            btn.style.marginTop = '5px';
            btn.onclick = () => { 
                Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, activeToolboxFile, 'arcade')); 
                alert("Resent."); 
            };
            $('arcadeStatus').parentNode.appendChild(btn);
        }
        
        // Broadcast to existing viewers (Stream)
        Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file, 'arcade'));
        
        // Share Breakout Link in Public Chat
        socket.emit('public-chat', { 
            room: currentRoom, 
            name: "ArcadeBot", 
            text: `New Game Loaded: ${file.name}. Join the Arcade Room: ${link}` 
        });
    });
}


// =======================================================================
// 13. USER LIST & UTILS
// =======================================================================
function renderUserList() {
    const list = $('userList'); 
    list.innerHTML = '';
    
    latestUserList.forEach(u => {
        if (u.id === myId) return;
        
        const div = document.createElement('div'); 
        div.className = 'user-item';
        div.innerHTML = `<span>${u.id === currentOwnerId ? '👑 ' : ''}${u.name}</span>`;
        
        const actionsDiv = document.createElement('div'); 
        actionsDiv.className = 'user-actions';
        const isCalling = !!callPeers[u.id];
        
        const callBtn = document.createElement('button'); 
        callBtn.className = 'action-btn';
        callBtn.textContent = isCalling ? 'End Call' : 'Call';
        callBtn.onclick = () => isCalling ? endPeerCall(u.id) : window.ringUser(u.id);
        actionsDiv.appendChild(callBtn);

        if (isCalling && iAmHost) {
            const selBtn = document.createElement('button'); 
            selBtn.className = 'action-btn';
            selBtn.textContent = (activeGuestId === u.id) ? 'Selected' : 'Select';
            selBtn.onclick = () => { 
                activeGuestId = u.id; 
                renderUserList(); 
                window.setActiveGuest(u.id); 
            };
            actionsDiv.appendChild(selBtn);
        }

        if (iAmHost) {
            const kickBtn = document.createElement('button'); 
            kickBtn.className = 'action-btn kick';
            kickBtn.textContent = 'Kick'; 
            kickBtn.onclick = () => window.kickUser(u.id);
            actionsDiv.appendChild(kickBtn);
        }
        
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
        d.innerHTML = `<video autoplay playsinline></video><h2>${callPeers[id]?.name || 'Guest'}</h2>`;
        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); 
    if(v.srcObject !== stream) {
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
    $('openStreamBtn').onclick = () => { 
        const url = $('streamLinkInput').value; 
        if(url) window.open(url, '_blank'); 
    };
}
