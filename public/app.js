// =======================================================================
// REBEL STREAM - HOST APPLICATION (FULL MONSTER VERSION)
// =======================================================================
// This file handles:
// 1. WebRTC Broadcasting (One-to-Many)
// 2. Canvas Video Mixing (Split/PIP/Solo)
// 3. Audio Mixing (Mic + System Audio)
// 4. P2P File Transfer (Arcade & Documents)
// 5. Room Administration (Kick/VIP/Lock)
// =======================================================================

console.log("Rebel Stream Host App Loaded - Full Version"); 

// --- CONFIGURATION ---
const CHUNK_SIZE = 16 * 1024; // 16KB chunks (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit to prevent crashes

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- DOM ELEMENTS ---
const $ = id => document.getElementById(id);

// --- GLOBAL VARIABLES ---
const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let latestUserList = [];
let currentOwnerId = null;

// --- SECURITY / VIP STATE ---
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
// This engine mixes your cam + guest cam into a single video feed
let audioContext = null;
let audioDestination = null;

// The Canvas is the "Master Output" for the stream
let canvas = document.createElement('canvas'); 
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 

// Layout Modes: 'SOLO', 'GUEST', 'PIP', 'SPLIT'
let mixerLayout = 'SOLO'; 
let activeGuestId = null; // The ID of the guest currently selected for the mixer

// --- PEER STORAGE ---
const viewerPeers = {}; // One-way connections (Broadcast Viewers)
const callPeers = {};   // Two-way connections (Room Guests)


// =======================================================================
// 1. ARCADE & FILE TRANSFER ENGINE (P2P)
// =======================================================================

/**
 * Sends a file via WebRTC Data Channel.
 * Supports both 'arcade' (auto-launch tools) and 'file' (chat downloads).
 */
async function pushFileToPeer(pc, file, type = 'arcade', onProgress) {
    if (!pc) {
        console.warn("Peer connection not ready for file transfer.");
        return;
    }

    // Create a specific data channel for this transfer
    // We use a new channel for each file to ensure clean buffers
    const channel = pc.createDataChannel("transfer-pipe");

    channel.onopen = async () => {
        console.log(`[P2P] Starting transfer of ${type}: ${file.name}`);

        // 1. Send Metadata (So the receiver knows what is coming)
        const metadata = JSON.stringify({
            dataType: type, // 'arcade' or 'file'
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
                console.log(`[P2P] Transfer Complete: ${file.name}`);
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

/**
 * Sets up a listener for incoming files (For the Host to receive files from guests)
 */
function setupDataReceiver(pc, peerId) {
    pc.ondatachannel = (e) => {
        const chan = e.channel;
        
        // Only accept transfer pipes
        if (chan.label !== "transfer-pipe" && chan.label !== "side-load-pipe") return;

        let receivedChunks = [];
        let totalSize = 0;
        let currentSize = 0;
        let meta = null;

        chan.onmessage = (event) => {
            const data = event.data;

            // 1. Handle Metadata (First packet is JSON string)
            if (typeof data === 'string') {
                try {
                    meta = JSON.parse(data);
                    totalSize = meta.size;
                } catch(e) {
                    console.error("Failed to parse file metadata", e);
                }
            }
            
            // 2. Handle Binary Data (Chunks)
            if (data instanceof ArrayBuffer) {
                receivedChunks.push(data);
                currentSize += data.byteLength;
                
                // 3. File Complete
                if (currentSize >= totalSize) {
                    const blob = new Blob(receivedChunks, { type: meta ? meta.mime : 'application/octet-stream' });
                    const url = URL.createObjectURL(blob);
                    
                    if (meta && meta.dataType === 'file') {
                        // It is a user-shared file. Show in Private Chat.
                        const senderName = callPeers[peerId] ? callPeers[peerId].name : "Guest";
                        addFileToChat(senderName, meta.name, url);
                    } else {
                        console.log("Host received Arcade payload (ignored).");
                    }
                    
                    chan.close();
                }
            }
        };
    };
}

/**
 * Adds a download link card to the chat window
 */
function addFileToChat(senderName, fileName, url) {
    const log = $('chatLogPrivate');
    if (!log) return;

    const div = document.createElement('div');
    div.className = 'chat-line system-msg';
    
    div.innerHTML = `
        <div style="background: rgba(255,255,255,0.05); border: 1px solid #444; padding: 10px; border-radius: 8px; margin: 10px 0;">
            <div style="margin-bottom:5px;">
                <strong>${senderName}</strong> shared a file:
            </div>
            <div style="color:#4af3a3; font-weight:bold; font-size:0.9rem; word-break:break-all;">
                ${fileName}
            </div>
            <a href="${url}" download="${fileName}" class="btn small primary" style="margin-top:8px; display:inline-block; text-decoration:none;">
                ⬇️ Download File
            </a>
        </div>
    `;
    
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    
    // Notify user if they are on another tab
    if (tabs.room && !tabs.room.classList.contains('active')) {
        tabs.room.classList.add('has-new');
    }
}


// =======================================================================
// 2. CANVAS MIXER ENGINE (BROADCAST LOGIC)
// =======================================================================

function drawMixer() {
    if (!ctx) return;
    
    // 1. Paint Background (Black)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Get Source Elements
    const myVideo = $('localVideo'); // This is always YOU or YOUR SCREEN
    let guestVideo = null;
    
    // Attempt to find the guest video element
    if (activeGuestId) {
        const container = document.getElementById(`vid-${activeGuestId}`);
        if (container) {
            guestVideo = container.querySelector('video');
        }
    }

    // 3. Draw based on Layout Mode
    if (mixerLayout === 'SOLO') {
        // --- SOLO MODE: Just the Host ---
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        }
    } 
    else if (mixerLayout === 'GUEST') {
        // --- GUEST MODE: Just the Guest ---
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        } else {
            // Placeholder text if guest isn't ready
            ctx.fillStyle = '#222'; 
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#fff'; 
            ctx.font = "60px Arial"; 
            ctx.textAlign = "center";
            ctx.fillText("Waiting for Guest Signal...", canvas.width/2, canvas.height/2);
        }
    }
    else if (mixerLayout === 'SPLIT') {
        // --- SPLIT MODE: Side-by-Side (Letterboxed) ---
        
        // Canvas is 1920x1080. Half width is 960.
        // A 16:9 video scaled to 960px width is 540px tall.
        // To center it vertically: (1080 - 540) / 2 = 270px offset.
        
        const slotW = 960;
        const vidH = 540; 
        const yOffset = (1080 - vidH) / 2;

        // Draw Host (Left Side)
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, yOffset, slotW, vidH);
        }
        
        // Draw Guest (Right Side)
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
    else if (mixerLayout === 'PIP') {
        // --- PIP MODE: Host Full + Guest Small ---
        
        // Host Base
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

    // Keep the loop running
    requestAnimationFrame(drawMixer);
}

// Initialize the Mixer Stream
// We capture at 30 FPS for the broadcast
canvasStream = canvas.captureStream(30); 
drawMixer(); // Start the engine

// Expose Mixer Controls to HTML Buttons
window.setMixerLayout = (mode) => {
    mixerLayout = mode;
    console.log(`Switched Layout to: ${mode}`);
    
    // Update Button UI Highlight
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active');
        if (b.textContent.toUpperCase().includes(mode) || (mode === 'PIP' && b.textContent.includes('Overlay'))) {
            b.classList.add('active');
        }
    });
};

window.setActiveGuest = (id) => {
    activeGuestId = id;
    alert(`Guest Selected! Switch to 'Overlay' or 'Split' to see them on stream.`);
};


// =======================================================================
// 4. TAB NAVIGATION LOGIC
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

    // Reset all tabs
    Object.values(tabs).forEach(t => t.classList.remove('active'));
    Object.values(contents).forEach(c => c.classList.remove('active'));

    // Activate the selected one
    tabs[name].classList.add('active');
    contents[name].classList.add('active');

    // Remove notification badge
    tabs[name].classList.remove('has-new');
}

// Bind Click Listeners
Object.keys(tabs).forEach(k => { 
    if(tabs[k]) {
        tabs[k].addEventListener('click', () => switchTab(k));
    }
});


// =======================================================================
// 5. DEVICE SETTINGS & SELECTION
// =======================================================================

const settingsPanel = $('settingsPanel');
const audioSource = $('audioSource');
const audioSource2 = $('audioSource2'); // Mixer Input
const videoSource = $('videoSource');
const videoQuality = $('videoQuality');

if ($('settingsBtn')) {
    $('settingsBtn').addEventListener('click', () => {
        const isHidden = settingsPanel.style.display === 'none' || settingsPanel.style.display === '';
        settingsPanel.style.display = isHidden ? 'block' : 'none';
        
        if (isHidden) {
            getDevices(); // Refresh devices when opening
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
        
        if(audioSource2) {
            audioSource2.innerHTML = '<option value="">-- None --</option>';
        }

        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
            
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt);
                // Add to mixer list too
                if(audioSource2) {
                    audioSource2.appendChild(opt.cloneNode(true));
                }
            }
            if (d.kind === 'videoinput') {
                videoSource.appendChild(opt);
            }
        });

        // Try to maintain current selection
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

// Auto-update media when selection changes
audioSource.onchange = startLocalMedia;
if(audioSource2) audioSource2.onchange = startLocalMedia;
videoSource.onchange = startLocalMedia;
if(videoQuality) videoQuality.onchange = startLocalMedia;


// =======================================================================
// 6. MEDIA CONTROLS (CAMERA, MIC, MIXING)
// =======================================================================

async function startLocalMedia() {
    // If sharing screen, don't override the video track yet
    if (isScreenSharing) {
        return; 
    }

    // Stop previous tracks to release hardware
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    try {
        // --- RESOLUTION LOGIC ---
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
            audio: { 
                deviceId: audioSource.value ? { exact: audioSource.value } : undefined 
            },
            video: { 
                deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
                width: widthConstraint,
                height: heightConstraint
            }
        };

        const mainStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // --- AUDIO MIXING LOGIC ---
        let finalAudioTrack = mainStream.getAudioTracks()[0];
        const secondaryId = audioSource2 ? audioSource2.value : null;

        if (secondaryId) {
            // User selected a second mic/music source
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

        // --- SET LOCAL STREAM ---
        localStream = new MediaStream([
            mainStream.getVideoTracks()[0], 
            finalAudioTrack
        ]);
        
        // Show in local preview
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true; // Always mute local to prevent echo loop

        // --- UPDATE PEERS ---
        // 1. Viewers get the MIXED CANVAS stream + Mixed Audio
        const mixedVideoTrack = canvasStream.getVideoTracks()[0];
        
        const updateViewerPC = (pc) => {
            if (!pc) return;
            const senders = pc.getSenders();
            
            // Video -> Canvas
            const vSender = senders.find(s => s.track && s.track.kind === 'video');
            if (vSender) vSender.replaceTrack(mixedVideoTrack);
            
            // Audio -> Mixed Audio
            const aSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (aSender) aSender.replaceTrack(finalAudioTrack);
        };
        Object.values(viewerPeers).forEach(updateViewerPC);
        
        // 2. Guests (P2P) get the RAW CAMERA + Mixed Audio
        // This is important so they see the Host clearly, not the stream layout.
        Object.values(callPeers).forEach(p => {
             const senders = p.pc.getSenders();
             
             const vSender = senders.find(s => s.track && s.track.kind === 'video');
             if(vSender) vSender.replaceTrack(mainStream.getVideoTracks()[0]);
             
             const aSender = senders.find(s => s.track && s.track.kind === 'audio');
             if(aSender) aSender.replaceTrack(finalAudioTrack);
        });

        $('hangupBtn').disabled = false;
        updateMediaButtons();

    } catch (e) { 
        console.error(e); 
        alert("Camera access failed. Check permissions or try a different device."); 
    }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];

    // Camera Button
    if ($('toggleCamBtn')) {
        const isCamOn = vTrack && vTrack.enabled;
        $('toggleCamBtn').textContent = isCamOn ? 'Camera On' : 'Camera Off';
        $('toggleCamBtn').classList.toggle('danger', !isCamOn);
    }

    // Mic Button
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


// =======================================================================
// 7. SCREEN SHARING LOGIC
// =======================================================================

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
                
                // Show screen locally
                $('localVideo').srcObject = screenStream;
                
                // Note: Canvas Mixer automatically reads from 'localVideo', so 
                // the stream is automatically updated with the screen content.

                // HOWEVER, we must manually update GUESTS (P2P) because they receive raw tracks
                const screenTrack = screenStream.getVideoTracks()[0];
                const screenAudio = screenStream.getAudioTracks()[0]; 

                Object.values(callPeers).forEach(p => {
                    p.pc.getSenders().forEach(s => {
                        if(s.track.kind === 'video') s.replaceTrack(screenTrack);
                        // If system audio exists, replace mic. If not, keep mic.
                        if(screenAudio && s.track.kind === 'audio') s.replaceTrack(screenAudio);
                    });
                });
                
                // Handle native "Stop Sharing" bar
                screenStream.getVideoTracks()[0].onended = stopScreenShare;

            } catch(e) { 
                console.error("Screen share cancelled", e); 
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
    
    // Reset Button
    $('shareScreenBtn').textContent = 'Share Screen';
    $('shareScreenBtn').classList.remove('danger');
    
    // Switch back to Camera
    startLocalMedia();
}


// =======================================================================
// 8. BROADCAST STREAMING (1-to-Many)
// =======================================================================

if ($('startStreamBtn')) {
    $('startStreamBtn').addEventListener('click', async () => {
        if (!currentRoom || !iAmHost) {
            return alert("Host only functionality.");
        }
        
        if (isStreaming) {
            // STOP STREAMING
            isStreaming = false;
            $('startStreamBtn').textContent = "Start Stream";
            $('startStreamBtn').classList.remove('danger');
            
            // Close all viewer connections
            Object.values(viewerPeers).forEach(pc => pc.close());
            for (const k in viewerPeers) delete viewerPeers[k];
            
        } else {
            // START STREAMING
            if (!localStream) await startLocalMedia();
            
            isStreaming = true;
            $('startStreamBtn').textContent = "Stop Stream"; 
            $('startStreamBtn').classList.add('danger');
            
            // Connect to everyone already in the list
            latestUserList.forEach(u => { 
                if (u.id !== myId) {
                    connectViewer(u.id); 
                }
            });
        }
    });
}


// =======================================================================
// 9. P2P CALLING (1-to-1)
// =======================================================================

if ($('hangupBtn')) {
    $('hangupBtn').addEventListener('click', () => {
        // Ends all P2P calls but keeps stream active
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
    
    // Setup File Receiver for this peer
    setupDataReceiver(pc, targetId);

    pc.onicecandidate = e => { 
        if (e.candidate) {
            socket.emit('call-ice', { targetId, candidate: e.candidate }); 
        }
    };

    // Receive Remote Video
    pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]);
    
    // Send Local Video (Raw)
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
    
    // Setup File Receiver
    setupDataReceiver(pc, from);

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


// =======================================================================
// 10. VIEWER CONNECTION (BROADCAST)
// =======================================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return;
    
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    // *** FORCE CONTROL CHANNEL ***
    // Required for Arcade to work if file sent later
    pc.createDataChannel("control");

    pc.onicecandidate = e => { 
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { targetId, candidate: e.candidate }); 
        }
    };
    
    // Send Canvas Stream
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    if(localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if(audioTrack) pc.addTrack(audioTrack, canvasStream);
    }
    
    // Auto-Push Active Tool
    if (activeToolboxFile) {
        console.log(`[Arcade] Auto-pushing to ${targetId}`);
        pushFileToPeer(pc, activeToolboxFile, 'arcade'); 
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
// 11. SOCKET & ROOM LOGIC
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

socket.on('user-joined', ({ id, name }) => {
    // Bouncer Logic
    if (iAmHost && isPrivateMode && !allowedGuests.some(g => g.toLowerCase() === name.toLowerCase())) {
        socket.emit('kick-user', id); 
        return;
    }
    appendChat($('chatLogPrivate'), 'System', `${name} joined room`, Date.now());
    if (iAmHost && isStreaming) connectViewer(id);
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
    if ($('localContainer')) {
        $('localContainer').querySelector('h2').textContent = isHost ? 'You (Host)' : 'You';
    }
    $('hostControls').style.display = isHost ? 'block' : 'none';
    renderUserList();
});


// =======================================================================
// 12. CONTROLS (TITLE, SLUG, ADMIN)
// =======================================================================

if ($('updateTitleBtn')) {
    $('updateTitleBtn').addEventListener('click', () => {
        const title = $('streamTitleInput').value.trim();
        if (title) socket.emit('update-stream-title', title);
    });
}

if ($('updateSlugBtn')) {
    $('updateSlugBtn').addEventListener('click', () => {
        const slug = $('slugInput').value.trim();
        if (slug) updateLink(slug);
    });
}

if ($('togglePrivateBtn')) {
    $('togglePrivateBtn').addEventListener('click', () => {
        isPrivateMode = !isPrivateMode;
        $('togglePrivateBtn').textContent = isPrivateMode ? "ON" : "OFF";
        $('togglePrivateBtn').className = isPrivateMode ? "btn small danger" : "btn small secondary";
        $('guestListPanel').style.display = isPrivateMode ? "block" : "none";
        
        if (isPrivateMode) {
            latestUserList.forEach(u => {
                if (u.id !== myId) {
                    const allowed = allowedGuests.some(g => g.toLowerCase() === u.name.toLowerCase());
                    if (!allowed) socket.emit('kick-user', u.id);
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


// =======================================================================
// 13. CHAT SYSTEM
// =======================================================================

function appendChat(log, name, text, ts) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    const s = document.createElement('strong'); 
    s.textContent = name;
    const t = document.createElement('small'); 
    t.textContent = new Date(ts).toLocaleTimeString();
    const txt = document.createTextNode(`: ${text}`);
    d.append(s, document.createTextNode(' '), t, txt);
    log.appendChild(d); 
    log.scrollTop = log.scrollHeight;
}

function sendPublic() {
    const inp = $('inputPublic'); 
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit('public-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
if ($('btnSendPublic')) $('btnSendPublic').addEventListener('click', sendPublic);
if ($('inputPublic')) $('inputPublic').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPublic(); });

function sendPrivate() {
    const inp = $('inputPrivate'); 
    const text = inp.value.trim();
    if(!text || !currentRoom) return;
    socket.emit('private-chat', { room: currentRoom, name: userName, text });
    inp.value = '';
}
if ($('btnSendPrivate')) $('btnSendPrivate').addEventListener('click', sendPrivate);
if ($('inputPrivate')) $('inputPrivate').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendPrivate(); });

// Receive Messages
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


// =======================================================================
// 14. FILE SHARING (P2P Implementation)
// =======================================================================

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
        if(!file) return;
        
        // P2P FILE SHARE: Send to all connected GUESTS (callPeers)
        const guests = Object.values(callPeers);
        
        if(guests.length === 0) {
            return alert("No guests in the room to share file with.");
        }
        
        // Send file to each guest via their data channel
        guests.forEach(p => {
            pushFileToPeer(p.pc, file, 'file', (pct) => {
                $('fileNameLabel').textContent = `Sending: ${pct}%`;
                if(pct >= 100) $('fileNameLabel').textContent = "Sent!";
            });
        });
        
        // Add to my own chat log so I see it
        addFileToChat("You", file.name, URL.createObjectURL(file));
    });
}


// =======================================================================
// 15. ARCADE INPUT LOGIC
// =======================================================================

const arcadeInput = $('arcadeInput');
if (arcadeInput) {
    arcadeInput.addEventListener('change', () => {
        const file = arcadeInput.files[0];
        if(!file) return;
        
        activeToolboxFile = file;
        $('arcadeStatus').textContent = `Active Tool: ${file.name}`;
        
        // --- ADD FORCE RESEND BUTTON ---
        let resendBtn = document.getElementById('resendToolBtn');
        if(!resendBtn) {
            resendBtn = document.createElement('button');
            resendBtn.id = 'resendToolBtn';
            resendBtn.textContent = 'Force Resend Tool';
            resendBtn.className = 'btn small secondary full-width';
            resendBtn.style.marginTop = '5px';
            resendBtn.onclick = () => {
                console.log("Forcing arcade resend...");
                Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, activeToolboxFile, 'arcade'));
                alert("Tool resent to all connected viewers.");
            };
            $('arcadeStatus').parentNode.appendChild(resendBtn);
        }
        
        // Push file to all currently connected VIEWERS (Public Stream)
        Object.values(viewerPeers).forEach(pc => pushFileToPeer(pc, file, 'arcade'));
    });
}


// =======================================================================
// 16. USER LIST & MIXER SELECTION RENDERER
// =======================================================================

function renderUserList() {
    const list = $('userList'); 
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
        
        // CALL BUTTON
        const callBtn = document.createElement('button');
        callBtn.className = 'action-btn';
        callBtn.textContent = isCalling ? 'End Call' : 'Call';
        callBtn.onclick = () => isCalling ? endPeerCall(u.id) : window.ringUser(u.id);
        actionsDiv.appendChild(callBtn);

        // MIXER SELECT
        if (isCalling && iAmHost) {
            const selBtn = document.createElement('button');
            selBtn.className = 'action-btn';
            selBtn.textContent = (activeGuestId === u.id) ? 'Selected' : 'Select';
            selBtn.title = "Select for Overlay/Split";
            selBtn.onclick = () => {
                activeGuestId = u.id;
                renderUserList(); 
                window.setActiveGuest(u.id);
            };
            actionsDiv.appendChild(selBtn);
        }

        // KICK
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

        const h2 = document.createElement('h2');
        h2.textContent = callPeers[id] ? callPeers[id].name : "Guest";
        d.appendChild(h2);

        $('videoGrid').appendChild(d);
    }
    const v = d.querySelector('video'); 
    if(v.srcObject !== stream) v.srcObject = stream;
}

function removeRemoteVideo(id) { 
    const el = document.getElementById(`vid-${id}`); 
    if(el) el.remove(); 
}

// Make functions globally available
window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

if ($('openStreamBtn')) {
    $('openStreamBtn').addEventListener('click', () => { 
        const url = $('streamLinkInput').value; 
        if(url) window.open(url, '_blank'); 
    });
}
