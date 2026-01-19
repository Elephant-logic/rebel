// REBEL MESSENGER / STREAM HOST APP
// =================================
// This is the main host-side logic for:
// - Room + role management (host / guest / viewer)
// - Stream mixer (canvas compositing)
// - Calls (1:1 via WebRTC)
// - Viewer broadcast (WebRTC to view.html)
// - Chat (public & private)
// - Arcade (tool/file push)
// - HTML overlay engine (title/stats/chat for stream)

// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
const CHUNK_SIZE = 16 * 1024; 
const MAX_BUFFER = 256 * 1024; 

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;
    const channel = pc.createDataChannel("side-load-pipe");
    channel.onopen = async () => {
        const metadata = JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type });
        channel.send(metadata);
        const buffer = await file.arrayBuffer();
        let offset = 0;
        const sendLoop = () => {
            if (channel.bufferedAmount > MAX_BUFFER) { setTimeout(sendLoop, 10); return; }
            if (channel.readyState !== 'open') return;
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;
            if (onProgress) onProgress(Math.min(100, Math.round((offset / file.size) * 100)));
            if (offset < buffer.byteLength) setTimeout(sendLoop, 0);
            else setTimeout(() => channel.close(), 1000);
        };
        sendLoop();
    };
}

// ======================================================
// 2. MAIN APP SETUP & VARIABLES
// ======================================================
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
let mutedUsers = new Set();

let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false;

let activeToolboxFile = null;
let audioContext = null;
let audioDestination = null;
const audioAnalysers = {};

let canvas = document.createElement('canvas');
canvas.width = 1920; 
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let mixerLayout = 'SOLO';
let activeGuestId = null;

let overlayActive = false;
let overlayImage = new Image(); 
let currentRawHTML = "";

const viewerPeers = {};
const callPeers = {};

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ======================================================
// 3. CANVAS MIXER ENGINE (CPU Optimization)
// ======================================================
let lastDrawTime = 0;
const fpsInterval = 1000 / 30;

function drawMixer(timestamp) {
    requestAnimationFrame(drawMixer);
    const elapsed = timestamp - lastDrawTime;
    if (elapsed < fpsInterval) return;
    lastDrawTime = timestamp - (elapsed % fpsInterval);

    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const myVideo = $('localVideo');
    let guestVideo = null;
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`);
        if (el) guestVideo = el.querySelector('video');
    }

    // Mixer Modes
    if (mixerLayout === 'SOLO' && myVideo?.readyState === 4) {
        ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
    } else if (mixerLayout === 'PIP' && myVideo?.readyState === 4) {
        ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        if (guestVideo?.readyState === 4) {
            ctx.drawImage(guestVideo, 1400, 750, 480, 270);
        }
    }

    // Image-based Overlays (Fallback)
    if (overlayActive && overlayImage.complete) {
        ctx.drawImage(overlayImage, 0, 0, canvas.width, canvas.height);
    }
}
let canvasStream = canvas.captureStream(30);
requestAnimationFrame(drawMixer);

// ======================================================
// AUDIO & BITRATE HELPERS
// ======================================================
function setupAudioAnalysis(id, stream) {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        audioAnalysers[id] = { analyser, data: new Uint8Array(analyser.frequencyBinCount), vol: 0 };
    } catch (e) { console.warn("Audio fail", e); }
}

async function applyBitrateConstraints(pc) {
    const senders = pc.getSenders();
    const vSender = senders.find(s => s.track && s.track.kind === 'video');
    if (vSender) {
        try {
            const params = vSender.getParameters();
            if (!params.encodings) params.encodings = [{}];
            params.encodings[0].maxBitrate = 2500 * 1000;
            await vSender.setParameters(params);
        } catch (e) { console.error("Bitrate cap fail", e); }
    }
}

// ======================================================
// HTML LAYOUT ENGINE (The Side-Loader)
// ======================================================
function buildChatHTMLFromLogs(maxLines = 12) {
    const log = $('chatLogPublic');
    if (!log) return '';
    const last = Array.from(log.querySelectorAll('.chat-line')).slice(-maxLines);
    return last.map(line => {
        const name = line.querySelector('strong')?.textContent || '';
        const time = line.querySelector('small')?.textContent || '';
        const text = line.textContent.split(':').slice(1).join(':').trim();
        return `<div class="ov-chat-line"><b>${name}</b>: ${text}</div>`;
    }).join('');
}

function renderHTMLLayout(htmlString) {
    if (!htmlString) return;
    currentRawHTML = htmlString;
    overlayActive = true;

    // We inject this into the host preview for the user to see
    let overlayLayer = $('mixerOverlayLayer');
    if (!overlayLayer) {
        overlayLayer = document.createElement('div');
        overlayLayer.id = 'mixerOverlayLayer';
        overlayLayer.style.cssText = "position:absolute; inset:0; z-index:100; pointer-events:none; overflow:hidden;";
        $('localContainer').style.position = "relative";
        $('localContainer').appendChild(overlayLayer);
    }

    const processedHTML = htmlString
        .replace(/{{viewers}}/g, latestUserList.filter(u => u.isViewer).length)
        .replace(/{{title}}/g, $('streamTitleInput')?.value || "Rebel Stream")
        .replace(/{{chat}}/g, buildChatHTMLFromLogs(14));

    const videoEl = $('localVideo');
    const scale = (videoEl?.offsetWidth > 0) ? (videoEl.offsetWidth / 1920) : 1;
    
    overlayLayer.innerHTML = `
        <div style="width:1920px; height:1080px; transform-origin: top left; transform: scale(${scale});">
            ${processedHTML}
        </div>
    `;

    // TELL VIEWERS TO UPDATE
    if (iAmHost && isStreaming) {
        socket.emit('public-chat', {
            room: currentRoom,
            name: "SYSTEM",
            text: `COMMAND:update-overlay`
        });
    }
}

// ======================================================
// 4. TAB NAVIGATION
// ======================================================
const tabs = { stream: $('tabStreamChat'), room: $('tabRoomChat'), files: $('tabFiles'), users: $('tabUsers') };
const contents = { stream: $('contentStreamChat'), room: $('contentRoomChat'), files: $('contentFiles'), users: $('contentUsers') };

function switchTab(name) {
    if (!tabs[name]) return;
    Object.values(tabs).forEach(t => t?.classList.remove('active'));
    Object.values(contents).forEach(c => c?.classList.remove('active'));
    tabs[name].classList.add('active');
    contents[name].classList.add('active');
}

if (tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if (tabs.room) tabs.room.onclick = () => switchTab('room');
if (tabs.files) tabs.files.onclick = () => switchTab('files');
if (tabs.users) tabs.users.onclick = () => switchTab('users');

// ======================================================
// 5. DEVICE SETTINGS
// ======================================================
async function getDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const aIn = $('audioSource'), vIn = $('videoSource');
    if (aIn) aIn.innerHTML = ''; if (vIn) vIn.innerHTML = '';
    devices.forEach(d => {
        const opt = document.createElement('option'); opt.value = d.deviceId; opt.text = d.label || d.kind;
        if (d.kind === 'audioinput') aIn?.appendChild(opt);
        if (d.kind === 'videoinput') vIn?.appendChild(opt);
    });
}

// ======================================================
// 6. MEDIA CONTROLS
// ======================================================
async function startLocalMedia() {
    if (isScreenSharing) return;
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    try {
        const constraints = { audio: true, video: { width: 1280, height: 720 } };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if ($('localVideo')) $('localVideo').srcObject = localStream;
        updateMediaButtons();
    } catch (e) { console.error("Media failed", e); }
}

function updateMediaButtons() {
    if (!localStream) return;
    const vT = localStream.getVideoTracks()[0];
    const aT = localStream.getAudioTracks()[0];
    if ($('toggleCamBtn')) $('toggleCamBtn').textContent = vT.enabled ? 'Camera On' : 'Camera Off';
    if ($('toggleMicBtn')) $('toggleMicBtn').textContent = aT.enabled ? 'Mute' : 'Unmute';
}

// ======================================================
// 7. SCREEN SHARING
// ======================================================
if ($('shareScreenBtn')) {
    $('shareScreenBtn').onclick = async () => {
        if (isScreenSharing) { stopScreenShare(); }
        else {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            isScreenSharing = true;
            $('localVideo').srcObject = screenStream;
            screenStream.getVideoTracks()[0].onended = stopScreenShare;
        }
    };
}
function stopScreenShare() { isScreenSharing = false; startLocalMedia(); }

// ======================================================
// 8. BROADCAST STREAMING
// ======================================================
async function handleStartStream() {
    if (!iAmHost) return;
    isStreaming = true;
    $('startStreamBtn').textContent = "Stop Stream";
    latestUserList.forEach(u => { if (u.id !== myId) connectViewer(u.id); });
}

if ($('startStreamBtn')) {
    $('startStreamBtn').onclick = () => {
        if (isStreaming) { isStreaming = false; $('startStreamBtn').textContent = "Start Stream"; }
        else handleStartStream();
    };
}

// ======================================================
// 9. P2P CALLING (1-to-1)
// ======================================================
socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`Incoming call from ${from}. Accept?`)) await callPeer(fromId);
});

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
}

socket.on('incoming-call', async ({ from, name, offer }) => {
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[from] = { pc, name };
    pc.onicecandidate = e => { if (e.candidate) socket.emit('call-ice', { targetId: from, candidate: e.candidate }); };
    pc.ontrack = e => addRemoteVideo(from, e.streams[0]);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call-answer', { targetId: from, answer });
});

socket.on('call-answer', async ({ from, answer }) => {
    if (callPeers[from]) await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('call-ice', ({ from, candidate }) => {
    if (callPeers[from]) callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate));
});

function endPeerCall(id) {
    if (callPeers[id]) { callPeers[id].pc.close(); delete callPeers[id]; removeRemoteVideo(id); }
}


// ======================================================
// 10. VIEWER CONNECTION & ARCADE PUSH (UPDATED: Bitrate Patch)
// ======================================================

async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return; //

    const pc = new RTCPeerConnection(iceConfig); //
    viewerPeers[targetId] = pc; //

    const controlChannel = pc.createDataChannel("control"); //

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', {
                targetId,
                candidate: e.candidate
            }); //
        }
    };

    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream)); //

    if (localStream) {
        const at = localStream.getAudioTracks()[0]; //
        if (at) pc.addTrack(at, canvasStream); //
    }

    if (activeToolboxFile) {
        pushFileToPeer(pc, activeToolboxFile, null); //
    }

    const offer = await pc.createOffer(); //
    await pc.setLocalDescription(offer); //

    // NEW: Apply Bitrate Patch before signaling
    await applyBitrateConstraints(pc);

    socket.emit('webrtc-offer', { targetId, sdp: offer }); //
}

socket.on('webrtc-answer', async ({ from, sdp }) => {
    if (viewerPeers[from]) {
        await viewerPeers[from].setRemoteDescription(
            new RTCSessionDescription(sdp)
        ); //
    }
});

socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
    if (viewerPeers[from]) {
        await viewerPeers[from].addIceCandidate(
            new RTCIceCandidate(candidate)
        ); //
    }
});

// ======================================================
// 11. SOCKET & ROOM LOGIC
// ======================================================

socket.on('connect', () => {
    const signalStatus = $('signalStatus'); //
    if (signalStatus) {
        signalStatus.className = 'status-dot status-connected'; //
        signalStatus.textContent = 'Connected'; //
    }
    myId = socket.id; //
});

socket.on('disconnect', () => {
    const signalStatus = $('signalStatus'); //
    if (signalStatus) {
        signalStatus.className = 'status-dot status-disconnected'; //
        signalStatus.textContent = 'Disconnected'; //
    }
});

const joinBtn = $('joinBtn'); //
if (joinBtn) {
    joinBtn.onclick = () => {
        const room = $('roomInput').value.trim(); //
        if (!room) return;

        currentRoom = room; //
        const nameInput = $('nameInput'); //
        userName = nameInput && nameInput.value.trim()
            ? nameInput.value.trim()
            : 'Host'; //

        socket.connect(); //
        socket.emit('join-room', { room, name: userName, isViewer: false }); //

        joinBtn.disabled = true; //
        const leaveBtn = $('leaveBtn'); //
        if (leaveBtn) leaveBtn.disabled = false; //

        updateLink(room); //
        startLocalMedia(); //
    };
}

const leaveBtn = $('leaveBtn'); //
if (leaveBtn) {
    leaveBtn.onclick = () => {
        window.location.reload(); //
    };
}

function generateQR(url) {
    const container = $('qrcode'); //
    if (container && typeof QRCode !== 'undefined') {
        container.innerHTML = ""; //
        new QRCode(container, {
            text: url,
            width: 128,
            height: 128,
            colorDark: "#4af3a3",
            colorLight: "#101524"
        }); //
    }
}

function updateLink(roomSlug) {
    const url = new URL(window.location.href); //
    url.pathname = url.pathname.replace('index.html', '') + 'view.html'; //
    url.search = `?room=${encodeURIComponent(roomSlug)}`; //
    const finalUrl = url.toString(); //

    const streamLinkInput = $('streamLinkInput'); //
    if (streamLinkInput) streamLinkInput.value = finalUrl; //

    generateQR(finalUrl); //
}

socket.on('user-joined', ({ id, name }) => {
    if (iAmHost && isPrivateMode) {
        const allowed = allowedGuests.some(
            g => g.toLowerCase() === name.toLowerCase()
        ); //
        if (!allowed) {
            socket.emit('kick-user', id); //
            return;
        }
    }

    const privateLog = $('chatLogPrivate'); //
    appendChat(privateLog, 'System', `${name} joined room`, Date.now()); //

    if (iAmHost && isStreaming) {
        connectViewer(id); //
    }
});

socket.on('user-left', ({ id }) => {
    if (viewerPeers[id]) {
        viewerPeers[id].close(); //
        delete viewerPeers[id]; //
    }
    endPeerCall(id, true); //
});

socket.on('room-update', ({ locked, streamTitle, ownerId, users }) => {
    latestUserList = users || []; //
    currentOwnerId = ownerId; //

    const streamTitleInput = $('streamTitleInput'); //
    if (streamTitle && streamTitleInput) {
        streamTitleInput.value = streamTitle; //
        updateLink($('roomInput').value || currentRoom); //
    }

    const lockRoomBtn = $('lockRoomBtn'); //
    if (lockRoomBtn) {
        lockRoomBtn.textContent = locked ? 'Unlock Room' : 'Lock Room'; //
        lockRoomBtn.onclick = () => {
            if (iAmHost) {
                socket.emit('lock-room', !locked); //
            }
        };
    }

    renderUserList(); //
    
    // Auto-update overlay stats when user count changes
    if (overlayActive) {
        renderHTMLLayout(currentRawHTML); //
    }
});

socket.on('role', async ({ isHost }) => {
    wasHost = iAmHost; //
    iAmHost = isHost; //

    const localContainer = $('localContainer'); //
    if (localContainer) {
        const h2 = localContainer.querySelector('h2'); //
        if (h2) {
            h2.textContent = isHost ? 'You (Host)' : 'You'; //
        }
    }

    const hostControls = $('hostControls'); //
    if (hostControls) {
        hostControls.style.display = isHost ? 'block' : 'none'; //
    }

    renderUserList(); //
});

// ======================================================
// 12. HOST CONTROLS
// ======================================================

const updateTitleBtn = $('updateTitleBtn'); //
if (updateTitleBtn) {
    updateTitleBtn.onclick = () => {
        const streamTitleInput = $('streamTitleInput'); //
        if (!streamTitleInput) return;
        const t = streamTitleInput.value.trim(); //
        if (t) {
            socket.emit('update-stream-title', t); //
            if (overlayActive) renderHTMLLayout(currentRawHTML); //
        }
    };
}

const streamTitleInput = $('streamTitleInput'); //
if (streamTitleInput) {
    streamTitleInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            const t = streamTitleInput.value.trim(); //
            if (t) {
                socket.emit('update-stream-title', t); //
                if (overlayActive) renderHTMLLayout(currentRawHTML); //
            }
        }
    };
}

const updateSlugBtn = $('updateSlugBtn'); //
if (updateSlugBtn) {
    updateSlugBtn.onclick = () => {
        const slugInput = $('slugInput'); //
        if (!slugInput) return;
        const s = slugInput.value.trim(); //
        if (s) updateLink(s); //
    };
}

const slugInput = $('slugInput'); //
if (slugInput) {
    slugInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            const s = slugInput.value.trim(); //
            if (s) updateLink(s); //
        }
    };
}

const togglePrivateBtn = $('togglePrivateBtn'); //
if (togglePrivateBtn) {
    togglePrivateBtn.onclick = () => {
        isPrivateMode = !isPrivateMode; //
        togglePrivateBtn.textContent = isPrivateMode ? "ON" : "OFF"; //
        togglePrivateBtn.className = isPrivateMode
            ? "btn small danger"
            : "btn small secondary"; //

        const guestListPanel = $('guestListPanel'); //
        if (guestListPanel) {
            guestListPanel.style.display = isPrivateMode ? "block" : "none"; //
        }

        if (isPrivateMode) {
            latestUserList.forEach(u => {
                if (
                    u.id !== myId &&
                    !allowedGuests.some(
                        g => g.toLowerCase() === u.name.toLowerCase()
                    )
                ) {
                    socket.emit('kick-user', u.id); //
                }
            }); //
        }
    };
}

const addGuestBtn = $('addGuestBtn'); //
if (addGuestBtn) {
    addGuestBtn.onclick = () => {
        const guestNameInput = $('guestNameInput'); //
        if (!guestNameInput) return;
        const n = guestNameInput.value.trim(); //
        if (n && !allowedGuests.includes(n)) {
            allowedGuests.push(n); //
            renderGuestList(); //
            guestNameInput.value = ''; //
        }
    };
}

function renderGuestList() {
    const d = $('guestListDisplay'); //
    if (!d) return; //

    d.innerHTML = ''; //
    allowedGuests.forEach(name => {
        const t = document.createElement('span'); //
        t.style.cssText = "background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem; margin:2px;"; //
        t.textContent = name; //
        d.appendChild(t); //
    });
}

// ======================================================
// 13. CHAT SYSTEM
// ======================================================

function appendChat(log, name, text, ts) {
    if (!log) return; //

    const d = document.createElement('div'); //
    d.className = 'chat-line'; //

    const s = document.createElement('strong'); //
    s.textContent = name; //

    const t = document.createElement('small'); //
    t.textContent = new Date(ts).toLocaleTimeString(); //

    d.appendChild(s); //
    d.appendChild(document.createTextNode(' ')); //
    d.appendChild(t); //
    d.appendChild(document.createTextNode(`: ${text}`)); //

    log.appendChild(d); //
    log.scrollTop = log.scrollHeight; //
}

function sendPublic() {
    const i = $('inputPublic'); //
    if (!i) return; //
    const t = i.value.trim(); //
    if (!t || !currentRoom) return; //

    socket.emit('overlay-html', {
        room: currentRoom,
        html: processedHTML
    }); //

    i.value = ''; //
}

const btnSendPublic = $('btnSendPublic'); //
if (btnSendPublic) {
    btnSendPublic.onclick = sendPublic; //
}

const inputPublic = $('inputPublic'); //
if (inputPublic) {
    inputPublic.onkeydown = (e) => {
        if (e.key === 'Enter') sendPublic(); //
    };
}

function sendPrivate() {
    const i = $('inputPrivate'); //
    if (!i) return; //
    const t = i.value.trim(); //
    if (!t || !currentRoom) return; //

    socket.emit('private-chat', {
        room: currentRoom,
        name: userName,
        text: t
    }); //

    i.value = ''; //
}

const btnSendPrivate = $('btnSendPrivate'); //
if (btnSendPrivate) {
    btnSendPrivate.onclick = sendPrivate; //
}

const inputPrivate = $('inputPrivate'); //
if (inputPrivate) {
    inputPrivate.onkeydown = (e) => {
        if (e.key === 'Enter') sendPrivate(); //
    };
}

socket.on('public-chat', d => {
    if (mutedUsers.has(d.name)) return; //
    const log = $('chatLogPublic'); //
    appendChat(log, d.name, d.text, d.ts); //
    if (tabs.stream && !tabs.stream.classList.contains('active')) {
        tabs.stream.classList.add('has-new'); //
    }
socket.on('overlay-update', ({ html }) => {
    if (typeof renderHTMLLayout === "function" && html) {
        renderHTMLLayout(html);
    }
});

    // When public chat updates & overlay is active, re-render layout
    if (overlayActive) {
        renderHTMLLayout(currentRawHTML); //
    }
});

socket.on('private-chat', d => {
    const log = $('chatLogPrivate'); //
    appendChat(log, d.name, d.text, d.ts); //
    if (tabs.room && !tabs.room.classList.contains('active')) {
        tabs.room.classList.add('has-new'); //
    }
});

const emojiStripPublic = $('emojiStripPublic'); //
if (emojiStripPublic) {
    emojiStripPublic.onclick = e => {
        if (e.target.classList.contains('emoji')) {
            const input = $('inputPublic'); //
            if (input) input.value += e.target.textContent; //
        }
    };
}

const emojiStripPrivate = $('emojiStripPrivate'); //
if (emojiStripPrivate) {
    emojiStripPrivate.onclick = e => {
        if (e.target.classList.contains('emoji')) {
            const input = $('inputPrivate'); //
            if (input) input.value += e.target.textContent; //
        }
    };
}

// ======================================================
// 14. FILE SHARING (TAB)
// ======================================================

const fileInput = $('fileInput'); //
if (fileInput) {
    fileInput.onchange = () => {
        if (fileInput.files.length) {
            const label = $('fileNameLabel'); //
            if (label) label.textContent = fileInput.files[0].name; //
            const sendBtn = $('sendFileBtn'); //
            if (sendBtn) sendBtn.disabled = false; //
        }
    };
}

const sendFileBtn = $('sendFileBtn'); //
if (sendFileBtn) {
    sendFileBtn.onclick = () => {
        if (!fileInput || !fileInput.files.length || !currentRoom) return; //

        const f = fileInput.files[0]; //

        if (f.size > 10 * 1024 * 1024) {
            alert("File too large (Limit: 10MB). Use 'Arcade'."); //
            return;
        }

        const r = new FileReader(); //
        r.onload = () => {
            socket.emit('file-share', {
                room: currentRoom,
                name: userName,
                fileName: f.name,
                fileData: r.result
            }); //
            fileInput.value = ''; //
            const label = $('fileNameLabel'); //
            if (label) label.textContent = 'No file selected'; //
            sendFileBtn.disabled = true; //
        };
        r.readAsDataURL(f); //
    };
}

socket.on('file-share', d => {
    const div = document.createElement('div'); //
    div.className = 'file-item'; //

    const info = document.createElement('div'); //
    const b = document.createElement('strong'); //
    b.textContent = d.name; //
    info.appendChild(b); //
    info.appendChild(
        document.createTextNode(` shared: ${d.fileName}`)
    ); //

    const link = document.createElement('a'); //
    link.href = d.fileData; //
    link.download = d.fileName; //
    link.className = 'btn small primary'; //
    link.textContent = 'Download'; //

    div.appendChild(info); //
    div.appendChild(link); //

    const fileLog = $('fileLog'); //
    if (fileLog) fileLog.appendChild(div); //

    if (tabs.files && !tabs.files.classList.contains('active')) {
        tabs.files.classList.add('has-new'); //
    }
});

// ======================================================
// 15. ARCADE & HTML OVERLAY
// ======================================================

const arcadeInput = $('arcadeInput'); //
if (arcadeInput) {
    arcadeInput.onchange = () => {
        const f = arcadeInput.files[0]; //
        if (!f) return; //

        activeToolboxFile = f; //

        const arcadeStatus = $('arcadeStatus'); //
        if (arcadeStatus) {
            arcadeStatus.textContent = `Active: ${f.name}`; //
        }

        Object.values(viewerPeers).forEach(pc => {
            pushFileToPeer(pc, f); //
        }); //
    };
}



window.clearOverlay = () => {
    overlayActive = false; //
    overlayImage = new Image(); //
    const overlayStatus = $('overlayStatus'); //
    if (overlayStatus) overlayStatus.textContent = "[Empty]"; //
};

// ======================================================
// 16. USER LIST & MIXER SELECTION (UPDATED: Stats Support)
// ======================================================

function renderUserList() {
    const list = $('userList'); //
    if (!list) return; //

    list.innerHTML = ''; //
    
    // Separate In-Room Guests from Stream Viewers
    const guests = latestUserList.filter(u => !u.isViewer); //
    const viewers = latestUserList.filter(u => u.isViewer); //

    const renderGroup = (label, users) => {
        if (users.length === 0) return; //
        const h = document.createElement('h4'); //
        h.style.cssText = "font-size:0.7rem; color:var(--muted); margin:10px 0 5px; text-transform:uppercase; border-bottom:1px solid var(--border); padding-bottom:4px;"; //
        h.textContent = label; //
        list.appendChild(h); //

        users.forEach(u => {
            if (u.id === myId) return; //

            const div = document.createElement('div'); //
            div.className = 'user-item'; //

            const nameSpan = document.createElement('span'); //
            if (u.id === currentOwnerId) {
                nameSpan.textContent = '👑 '; //
            }
            nameSpan.textContent += u.name; //
            
            // Show hand icon if requesting call
            if (u.requestingCall) {
                nameSpan.innerHTML += ' <span title="Requesting to Join Stream">✋</span>'; //
            }

            // NEW: Stats badge container for real-time monitoring
            const statsBadge = document.createElement('small');
            statsBadge.id = `stats-${u.id}`;
            statsBadge.style.cssText = "margin-left:8px; font-size:0.6rem; opacity:0.7;";
            nameSpan.appendChild(statsBadge);

            const actions = document.createElement('div'); //
            actions.className = 'user-actions'; //

            const isCalling = !!callPeers[u.id]; //

            if (iAmHost) {
                const mBtn = document.createElement('button'); //
                mBtn.className = 'action-btn'; //
                mBtn.textContent = mutedUsers.has(u.name) ? 'Unmute' : 'Mute'; //
                mBtn.onclick = () => {
                    if (mutedUsers.has(u.name)) {
                        mutedUsers.delete(u.name); //
                    } else {
                        mutedUsers.add(u.name); //
                    }
                    renderUserList(); //
                };
                actions.appendChild(mBtn); //
            }

            const callBtn = document.createElement('button'); //
            callBtn.className = 'action-btn'; //

            if (isCalling) {
                callBtn.textContent = 'End'; //
                callBtn.style.color = 'var(--danger)'; //
                callBtn.onclick = () => endPeerCall(u.id); //
            } else {
                // If viewer is requesting call, highlight button
                callBtn.textContent = u.requestingCall ? 'Accept & Call' : 'Call'; //
                if (u.requestingCall) callBtn.style.borderColor = "var(--accent)"; //
                callBtn.onclick = () => window.ringUser(u.id); //
            }
            actions.appendChild(callBtn); //

            if (isCalling && iAmHost) {
                const selBtn = document.createElement('button'); //
                selBtn.className = 'action-btn'; //
                selBtn.textContent = (activeGuestId === u.id) ? 'Selected' : 'Mix'; //
                selBtn.onclick = () => {
                    activeGuestId = u.id; //
                    renderUserList(); //
                    window.setActiveGuest(u.id); //
                };
                actions.appendChild(selBtn); //
            }

            if (iAmHost) {
                const pBtn = document.createElement('button'); //
                pBtn.className = 'action-btn'; //
                pBtn.textContent = '👑 Promote'; //
                pBtn.onclick = () => {
                    if (confirm(`Hand over Host to ${u.name}?`)) {
                        socket.emit('promote-to-host', { targetId: u.id }); //
                    }
                };
                actions.appendChild(pBtn); //

                const kBtn = document.createElement('button'); //
                kBtn.className = 'action-btn kick'; //
                kBtn.textContent = 'Kick'; //
                kBtn.onclick = () => window.kickUser(u.id); //
                actions.appendChild(kBtn); //
            }

            div.appendChild(nameSpan); //
            div.appendChild(actions); //
            list.appendChild(div); //
        });
    };

    renderGroup("In-Room Guests", guests); //
    renderGroup("Stream Viewers", viewers); //
}

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`); //
    if (!d) {
        d = document.createElement('div'); //
        d.className = 'video-container'; //
        d.id = `vid-${id}`; //

        const v = document.createElement('video'); //
        v.autoplay = true; //
        v.playsInline = true; //
        d.appendChild(v); //

        const h2 = document.createElement('h2'); //
        h2.textContent = callPeers[id] ? callPeers[id].name : "Guest"; //
        d.appendChild(h2); //

        const videoGrid = $('videoGrid'); //
        if (videoGrid) videoGrid.appendChild(d); //
    }

    const v = d.querySelector('video'); //
    if (v && v.srcObject !== stream) {
        v.srcObject = stream; //
        setupAudioAnalysis(id, stream); // NEW: Remote audio tracking
    }
}

function removeRemoteVideo(id) {
    const el = document.getElementById(`vid-${id}`); //
    if (el) el.remove(); //
    if (audioAnalysers[id]) delete audioAnalysers[id]; // Cleanup analyser
}

window.ringUser = (id) => socket.emit('ring-user', id); //
window.endPeerCall = endPeerCall; //
window.kickUser = (id) => socket.emit('kick-user', id); //

const openStreamBtn = $('openStreamBtn'); //
if (openStreamBtn) {
    openStreamBtn.onclick = () => {
        const u = $('streamLinkInput') && $('streamLinkInput').value; //
        if (u) window.open(u, '_blank'); //
    };
}
