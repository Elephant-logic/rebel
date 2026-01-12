// ==========================================
// REBEL MESSENGER - FULL CLIENT LOGIC
// ==========================================

// 1. SOCKET INITIALIZATION
const socket = io({ autoConnect: false });

// 2. GLOBAL STATE
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// MESH NETWORKING STATE
// We store multiple peer connections here.
// Key = socketId, Value = { pc: RTCPeerConnection }
const peers = {}; 

let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// Queue for ICE candidates that arrive before the remote description is set
const iceQueues = {}; // { [socketId]: [candidate, candidate...] }

// ICE Configuration
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? {
    iceServers: ICE_SERVERS
} : {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ==========================================
// 3. DOM ELEMENT REFERENCES
// ==========================================
const $ = id => document.getElementById(id);

// Connection & Room
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const signalStatus = $('signalStatus');
const roomInfo = $('roomInfo');

// Host Controls
const hostControls = $('hostControls');
const lockRoomBtn = $('lockRoomBtn');

// Video Elements
const localVideo = $('localVideo');
const remoteGrid = $('remoteVideosGrid'); // The container for multiple videos

// Call Controls
const callAllBtn = $('callAllBtn');
const startStreamBtn = $('startStreamBtn'); // ADDED BACK
const hangupBtn = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const settingsBtn = $('settingsBtn');

// Settings Panel
const settingsPanel = $('settingsPanel');
const closeSettingsBtn = $('closeSettingsBtn');
const audioSource = $('audioSource');
const videoSource = $('videoSource');

// Stream Link
const streamLinkInput = $('streamLinkInput');
const openStreamBtn = $('openStreamBtn');

// Tabs
const tabChatBtn = $('tabChatBtn');
const tabFilesBtn = $('tabFilesBtn');
const tabUsersBtn = $('tabUsersBtn');
const tabContentChat = $('tabContentChat');
const tabContentFiles = $('tabContentFiles');
const tabContentUsers = $('tabContentUsers');

// Chat & Files
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const emojiStrip = $('emojiStrip');
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');
const fileLog = $('fileLog');
const userList = $('userList');

// ==========================================
// 4. HELPER FUNCTIONS
// ==========================================

// Update Connection Status Indicator
function setSignal(connected) {
    if (!signalStatus) return;
    if (connected) {
        signalStatus.textContent = 'Connected';
        signalStatus.className = 'status-dot status-connected';
    } else {
        signalStatus.textContent = 'Disconnected';
        signalStatus.className = 'status-dot status-disconnected';
    }
}

// Tab Switching Logic
function switchTab(tab) {
    // Deactivate all
    [tabChatBtn, tabFilesBtn, tabUsersBtn].forEach(b => b && b.classList.remove('active'));
    [tabContentChat, tabContentFiles, tabContentUsers].forEach(c => c && c.classList.remove('active'));
    
    // Activate selected
    if (tab === 'chat') {
        if(tabChatBtn) tabChatBtn.classList.add('active'); 
        if(tabContentChat) tabContentChat.classList.add('active');
    } else if (tab === 'files') {
        if(tabFilesBtn) tabFilesBtn.classList.add('active'); 
        if(tabContentFiles) tabContentFiles.classList.add('active');
    } else if (tab === 'users') {
        if(tabUsersBtn) tabUsersBtn.classList.add('active'); 
        if(tabContentUsers) tabContentUsers.classList.add('active');
    }
}

// Expose switchTab to window if needed
window.switchTab = switchTab;

// ==========================================
// 5. MEDIA & DEVICE MANAGEMENT
// ==========================================

// Get Local Media (Camera/Mic)
async function ensureLocalStream() {
    if (localStream) return localStream;
    try {
        // Default constraints
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        
        // Attach to local video element
        if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true; // Mute self to prevent feedback
        }
    } catch (e) {
        console.error("Error accessing media:", e);
        alert("Could not access camera/microphone. Please check permissions.");
    }
    return localStream;
}

// Populate Settings Dropdowns
async function getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInput = devices.filter(d => d.kind === 'audioinput');
        const videoInput = devices.filter(d => d.kind === 'videoinput');

        if(audioSource) {
            audioSource.innerHTML = audioInput.map(d => 
                `<option value="${d.deviceId}">${d.label || 'Microphone ' + d.deviceId.slice(0,5)}</option>`
            ).join('');
        }
        if(videoSource) {
            videoSource.innerHTML = videoInput.map(d => 
                `<option value="${d.deviceId}">${d.label || 'Camera ' + d.deviceId.slice(0,5)}</option>`
            ).join('');
        }
    } catch(e) { console.error(e); }
}

// Switch Camera/Mic logic (Affects ALL active peers)
async function switchMedia() {
    // Stop current tracks
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }
    
    const audioId = audioSource ? audioSource.value : undefined;
    const videoId = videoSource ? videoSource.value : undefined;
    
    const constraints = {
        audio: { deviceId: audioId ? { exact: audioId } : undefined },
        video: { deviceId: videoId ? { exact: videoId } : undefined }
    };
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // Update local preview
        if(localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
        }

        // IMPORTANT: Replace tracks in ALL active peer connections
        const videoTrack = localStream.getVideoTracks()[0];
        const audioTrack = localStream.getAudioTracks()[0];

        Object.keys(peers).forEach(peerId => {
            const pc = peers[peerId].pc;
            if (!pc) return;

            const senders = pc.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            
            if (videoSender && videoTrack) {
                videoSender.replaceTrack(videoTrack).catch(e => console.error("Track replace error", e));
            }
            if (audioSender && audioTrack) {
                audioSender.replaceTrack(audioTrack).catch(e => console.error("Track replace error", e));
            }
        });
        
    } catch (e) {
        console.error("Switch media error:", e);
    }
}

// ==========================================
// 6. PEER CONNECTION FACTORY (Mesh Logic)
// ==========================================

// Creates a new RTCPeerConnection for a specific target user
function createPeerConnection(targetId) {
    if (peers[targetId]) return peers[targetId].pc;

    console.log("Creating new PeerConnection for:", targetId);
    const pc = new RTCPeerConnection(iceConfig);

    // Initialize ICE queue for this peer
    iceQueues[targetId] = [];

    // 1. Handle ICE Candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', {
                room: currentRoom,
                target: targetId, // Send ONLY to this target
                candidate: event.candidate
            });
        }
    };

    // 2. Handle Remote Streams (Create dynamic video elements)
    pc.ontrack = (event) => {
        console.log("Track received from:", targetId);
        const stream = event.streams[0];
        
        // Check if we already have a video card for this user
        let vid = document.getElementById(`vid-${targetId}`);
        
        if (!vid) {
            // Create the video card structure
            const card = document.createElement('div');
            card.className = 'video-card';
            card.id = `card-${targetId}`;
            
            const title = document.createElement('h2');
            title.textContent = `User ${targetId.substr(0,4)}`; // Placeholder name
            
            vid = document.createElement('video');
            vid.id = `vid-${targetId}`;
            vid.autoplay = true;
            vid.playsInline = true;
            
            card.appendChild(title);
            card.appendChild(vid);
            remoteGrid.appendChild(card);
        }
        
        vid.srcObject = stream;
    };

    // 3. Handle Connection State
    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${targetId}:`, pc.connectionState);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            removePeer(targetId);
        }
    };

    // Store the PC in our map
    peers[targetId] = { pc: pc };
    return pc;
}

// Cleanup a peer connection
function removePeer(id) {
    if (peers[id]) {
        console.log("Closing connection with:", id);
        peers[id].pc.close();
        delete peers[id];
        delete iceQueues[id];
    }
    // Remove UI element
    const card = document.getElementById(`card-${id}`);
    if (card) card.remove();
}

// ==========================================
// 7. CALLING & SIGNALING LOGIC
// ==========================================

// Initiates a call to a SINGLE specific user
window.callUser = async (targetId) => {
    if (!currentRoom) return;
    console.log("Initiating call to:", targetId);
    
    // Ensure we have media
    const stream = await ensureLocalStream();
    
    // Create PC
    const pc = createPeerConnection(targetId);
    
    // Add Tracks
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    
    // Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Send Signaling Message
    socket.emit('webrtc-offer', {
        room: currentRoom,
        target: targetId,
        sdp: offer
    });
    
    if (hangupBtn) hangupBtn.disabled = false;
};

// "Call All" Button Logic
function callAllUsers() {
    const userItems = document.querySelectorAll('.user-item');
    userItems.forEach(item => {
        const id = item.dataset.id;
        // Don't call ourselves
        if (id && id !== myId) {
            callUser(id);
        }
    });
}

// ==========================================
// 8. SOCKET EVENT HANDLERS
// ==========================================

socket.on('connect', () => {
    myId = socket.id;
    setSignal(true);
    console.log("Socket connected:", myId);
});

socket.on('disconnect', () => {
    setSignal(false);
    // Clear user list on disconnect
    if(userList) userList.innerHTML = '';
});

// A. WEBRTC OFFER RECEIVED
socket.on('webrtc-offer', async ({ sdp, from, name }) => {
    if (!currentRoom) return;
    console.log("Received Offer from:", from);
    
    // 1. Get Local Media
    const stream = await ensureLocalStream();
    
    // 2. Create PC (Pass 'from' as the target ID)
    const pc = createPeerConnection(from);
    
    // 3. Update the UI name if we know it
    setTimeout(() => {
        const card = document.getElementById(`card-${from}`);
        if(card && name) {
            card.querySelector('h2').textContent = name;
        }
    }, 500);

    // 4. Add Local Tracks
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    
    // 5. Set Remote Description
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // 6. Process Queued ICE Candidates
    if (iceQueues[from] && iceQueues[from].length > 0) {
        console.log(`Processing ${iceQueues[from].length} queued ICE candidates for ${from}`);
        while (iceQueues[from].length > 0) {
            const c = iceQueues[from].shift();
            await pc.addIceCandidate(c);
        }
    }

    // 7. Create Answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    // 8. Send Answer back to SPECIFIC target
    socket.emit('webrtc-answer', {
        room: currentRoom,
        target: from,
        sdp: answer
    });
    
    if (hangupBtn) hangupBtn.disabled = false;
});

// B. WEBRTC ANSWER RECEIVED
socket.on('webrtc-answer', async ({ sdp, from }) => {
    console.log("Received Answer from:", from);
    const peer = peers[from];
    if (peer && peer.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
});

// C. ICE CANDIDATE RECEIVED
socket.on('webrtc-ice-candidate', async ({ candidate, from }) => {
    const peer = peers[from];
    const ice = new RTCIceCandidate(candidate);
    
    if (peer && peer.pc) {
        // If remote description is set, add immediately
        if (peer.pc.remoteDescription) {
            await peer.pc.addIceCandidate(ice);
        } else {
            // Otherwise queue it
            console.log("Queueing ICE candidate for:", from);
            if (!iceQueues[from]) iceQueues[from] = [];
            iceQueues[from].push(ice);
        }
    }
});

// D. ROOM UPDATES (User List, Locking, Host)
socket.on('room-update', ({ users, ownerId, locked }) => {
    console.log("Room Update:", users);
    
    // Render User List
    if (!userList) return;
    userList.innerHTML = '';
    
    // Determine Host Status
    iAmHost = (myId === ownerId);
    
    // Show/Hide Host Controls
    if (hostControls) {
        hostControls.style.display = iAmHost ? 'block' : 'none';
    }
    
    // Update Lock Button Text
    if (lockRoomBtn) {
        lockRoomBtn.textContent = locked ? '🔒 Unlock Room' : '🔓 Lock Room';
        // Re-bind click event to ensure latest state
        lockRoomBtn.onclick = () => socket.emit('lock-room', !locked);
    }

    // Generate List Items
    users.forEach(u => {
        const isMe = (u.id === myId);
        const isOwner = (u.id === ownerId);
        
        const div = document.createElement('div');
        div.className = 'user-item';
        // Store ID in dataset for "Call All"
        div.dataset.id = u.id;
        
        // Buttons Logic
        let actionButtons = '';
        if (!isMe) {
            actionButtons = `
             <div class="user-actions">
               <button class="action-btn call" onclick="callUser('${u.id}')" title="Call User">📞</button>
               <button class="action-btn ring" onclick="socket.emit('ring-user', '${u.id}')" title="Ring User">🔔</button>
               ${iAmHost ? `<button class="action-btn kick" onclick="kickUser('${u.id}')" title="Kick User">🦵</button>` : ''}
             </div>
            `;
        }
        
        const displayName = isOwner ? `👑 ${u.name}` : u.name;
        
        div.innerHTML = `
            <span>
                <span style="font-weight:bold; color: ${isMe ? 'var(--accent)' : 'inherit'}">
                    ${displayName} ${isMe ? '(You)' : ''}
                </span>
            </span>
            ${actionButtons}
        `;
        
        userList.appendChild(div);
    });
});

// E. ALERTS (Kick, Ring, Error)
socket.on('kicked', () => {
    alert('You have been kicked from the room by the host.');
    window.location.reload();
});

socket.on('ring-alert', ({ from }) => {
    alert(`🔔 ${from} is ringing you!`);
    // Optional: play sound here
});

socket.on('room-error', (msg) => {
    alert(msg);
    if(joinBtn) joinBtn.disabled = false;
    if(leaveBtn) leaveBtn.disabled = true;
});

// F. USER JOINED (Auto-Call Logic)
socket.on('user-joined', ({ id, name }) => {
    // Show system message in chat
    if (id !== myId) appendChat('System', `${name} joined.`);
});

// ==========================================
// 9. SCREEN SHARING LOGIC
// ==========================================

if (shareScreenBtn) {
    shareScreenBtn.addEventListener('click', async () => {
        if (!currentRoom) return alert('Join a room first');
        
        // Ensure connection logic
        await ensureLocalStream();
        
        if (!isScreenSharing) {
            // START SHARING
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
                const screenTrack = screenStream.getVideoTracks()[0];
                
                // Replace video track in ALL peer connections
                Object.values(peers).forEach(({ pc }) => {
                    const sender = pc.getSenders().find(s => s.track.kind === 'video');
                    if (sender) sender.replaceTrack(screenTrack);
                });
                
                // Show local preview
                localVideo.srcObject = screenStream;
                
                isScreenSharing = true;
                shareScreenBtn.textContent = 'Stop Screen';
                
                // Handle system "Stop Sharing" bar
                screenTrack.onended = () => stopScreenShare();
                
            } catch (e) {
                console.error("Screen share error:", e);
            }
        } else {
            // STOP SHARING manually
            stopScreenShare();
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    
    // Stop screen tracks
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    
    // Revert to camera
    if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        // Replace back in all peers
        Object.values(peers).forEach(({ pc }) => {
            const sender = pc.getSenders().find(s => s.track.kind === 'video');
            if (sender) sender.replaceTrack(camTrack);
        });
        localVideo.srcObject = localStream;
    }
    
    isScreenSharing = false;
    shareScreenBtn.textContent = 'Share Screen';
}


// ==========================================
// 10. CHAT & FILE LOGIC
// ==========================================

// Helper: Append to chat log
function appendChat(name, text, ts = Date.now(), isOwner = false) {
    if (!chatLog) return;
    const line = document.createElement('div');
    line.className = 'chat-line';
    const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let nameHtml = `<strong>${name}</strong>`;
    if (name === 'You') nameHtml = `<span style="color:#4af3a3">${name}</span>`;
    else if (isOwner || name.includes('👑')) nameHtml = `<span style="color:#ffae00">👑 ${name.replace('👑','')}</span>`;
    
    line.innerHTML = `${nameHtml} <small>${t}</small>: ${text}`;
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight; // Auto scroll
}

// Socket: Incoming Chat
socket.on('chat-message', (data) => {
    appendChat(data.name, data.text, data.ts, data.isOwner);
});

// DOM: Send Button
if(sendBtn) sendBtn.addEventListener('click', () => {
    const txt = chatInput.value.trim();
    if (txt && currentRoom) {
        socket.emit('chat-message', { room: currentRoom, name: userName, text: txt });
        appendChat('You', txt);
        chatInput.value = '';
    }
});

// DOM: Enter Key
if(chatInput) chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
});

// DOM: Emoji Strip
if (emojiStrip) {
    emojiStrip.addEventListener('click', e => {
        if (e.target.classList.contains('emoji')) {
            chatInput.value += e.target.textContent;
            chatInput.focus();
        }
    });
}

// --- FILE SHARING ---

if (fileInput && sendFileBtn) {
    // Enable button on file selection
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        fileNameLabel.textContent = file ? file.name : 'No file selected';
        sendFileBtn.disabled = !file;
    });

    // Send File Logic
    sendFileBtn.addEventListener('click', () => {
        const file = fileInput.files[0];
        if (!file || !currentRoom) return;
        
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            socket.emit('file-share', {
                room: currentRoom,
                name: userName,
                fileName: file.name,
                fileType: file.type,
                fileData: base64
            });
            
            // Log local
            appendFileLog('You', file.name, `data:${file.type};base64,${base64}`);
            
            // Reset
            fileInput.value = '';
            fileNameLabel.textContent = 'No file selected';
            sendFileBtn.disabled = true;
            
            // Switch to files tab
            switchTab('files');
        };
        reader.readAsDataURL(file);
    });
}

// Helper: Append File Log
function appendFileLog(name, fileName, href) {
    if (!fileLog) return;
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
        <div>
            <div style="font-weight:bold; color:var(--accent);">${fileName}</div>
            <div style="font-size:0.7rem; color:var(--muted);">From: ${name}</div>
        </div>
        <a href="${href}" download="${fileName}" class="btn small primary">Download</a>
    `;
    fileLog.appendChild(item);
    
    // Notification in chat
    appendChat(name, `Shared a file: ${fileName} (See Files tab)`);
}

// Socket: Incoming File
socket.on('file-share', ({ name, fileName, fileType, fileData }) => {
    const href = `data:${fileType};base64,${fileData}`;
    appendFileLog(name, fileName, href);
});

// ==========================================
// 11. GENERAL UI EVENT LISTENERS
// ==========================================

// Global "Kick" function for onclick
window.kickUser = (id) => {
    if(confirm('Are you sure you want to kick this user?')) {
        socket.emit('kick-user', id);
    }
};

// Tabs Listeners
if(tabChatBtn) tabChatBtn.addEventListener('click', () => switchTab('chat'));
if(tabFilesBtn) tabFilesBtn.addEventListener('click', () => switchTab('files'));
if(tabUsersBtn) tabUsersBtn.addEventListener('click', () => switchTab('users'));

// Join Room Button
if (joinBtn) {
    joinBtn.addEventListener('click', () => {
        const room = roomInput.value.trim();
        if (!room) return alert('Enter room name');
        
        currentRoom = room;
        userName = nameInput.value.trim() || 'Anon';
        
        socket.connect();
        socket.emit('join-room', { room: currentRoom, name: userName });
        
        // Update UI
        joinBtn.disabled = true;
        leaveBtn.disabled = false;
        roomInfo.textContent = `Room: ${room}`;
        
        // Update Link
        const url = new URL(window.location.href);
        url.pathname = '/view.html'; 
        url.search = `?room=${encodeURIComponent(room)}`;
        if (streamLinkInput) streamLinkInput.value = url.toString();
    });
}

// Leave Room Button
if (leaveBtn) leaveBtn.addEventListener('click', () => window.location.reload());

// Call All Button
if(callAllBtn) callAllBtn.addEventListener('click', callAllUsers);

// Start Stream Button (Aliases to Call All for broadcast effect)
if(startStreamBtn) startStreamBtn.addEventListener('click', callAllUsers);

// Hangup Button
if (hangupBtn) hangupBtn.addEventListener('click', () => {
    // Close all connections
    Object.keys(peers).forEach(id => removePeer(id));
    
    // Stop local media
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    if(localVideo) localVideo.srcObject = null;
    
    hangupBtn.disabled = true;
});

// Toggles
if (toggleCamBtn) {
    toggleCamBtn.addEventListener('click', () => {
        if (!localStream) return;
        const v = localStream.getVideoTracks()[0];
        if (v) {
            v.enabled = !v.enabled;
            toggleCamBtn.textContent = v.enabled ? 'Camera Off' : 'Camera On';
        }
    });
}
if (toggleMicBtn) {
    toggleMicBtn.addEventListener('click', () => {
        if (!localStream) return;
        const a = localStream.getAudioTracks()[0];
        if (a) {
            a.enabled = !a.enabled;
            toggleMicBtn.textContent = a.enabled ? 'Mute' : 'Unmute';
        }
    });
}

// Settings Button
if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
        if(!settingsPanel) return;
        const isHidden = (settingsPanel.style.display === 'none');
        settingsPanel.style.display = isHidden ? 'block' : 'none';
        if (isHidden) await getDevices();
    });
}
if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
        if(!settingsPanel) return;
        settingsPanel.style.display = 'none';
        switchMedia(); // Apply changes
    });
}

// Open Stream Button
if (openStreamBtn) {
    openStreamBtn.addEventListener('click', () => {
        if (streamLinkInput && streamLinkInput.value) {
            window.open(streamLinkInput.value, '_blank');
        }
    });
}
