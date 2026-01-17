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
// This handles splitting games/tools into chunks 
// and sending them securely over WebRTC to all viewers.

const CHUNK_SIZE = 16 * 1024; // 16KB chunks (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit to prevent crashes

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return; //

    // Create a specific data channel for the arcade
    const channel = pc.createDataChannel("side-load-pipe"); //

    channel.onopen = async () => {
        console.log(`[Arcade] Starting transfer of: ${file.name}`); //

        // 1. Send Metadata (So the receiver knows what's coming)
        const metadata = JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            mime: file.type
        }); //
        channel.send(metadata); //

        // 2. Read the file into memory
        const buffer = await file.arrayBuffer(); //
        let offset = 0; //

        // 3. Send Loop (Chunks)
        const sendLoop = () => {
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10); //
                return;
            }

            if (channel.readyState !== 'open') {
                return; //
            }

            const chunk = buffer.slice(offset, offset + CHUNK_SIZE); //
            channel.send(chunk); //
            offset += CHUNK_SIZE; //

            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100)); //
                onProgress(percent); //
            }

            if (offset < buffer.byteLength) {
                setTimeout(sendLoop, 0); //
            } else {
                console.log(`[Arcade] Transfer Complete.`); //
                setTimeout(() => {
                    channel.close(); //
                }, 1000);
            }
        };
        sendLoop(); //
    };
}

// ======================================================
// 2. MAIN APP SETUP & VARIABLES
// ======================================================

console.log("Rebel Stream Host App Loaded"); //

const socket = io({ autoConnect: false }); //
const $ = id => document.getElementById(id); //

let currentRoom = null; //
let userName = 'User'; //
let myId = null; //
let iAmHost = false; //
let wasHost = false; //
let latestUserList = []; //
let currentOwnerId = null; //

let isPrivateMode = false; //
let allowedGuests = []; //
let mutedUsers = new Set(); //

let localStream = null; //
let screenStream = null; //
let isScreenSharing = false; //
let isStreaming = false; //

let activeToolboxFile = null; //

let audioContext = null; //
let audioDestination = null; //
const audioAnalysers = {}; // NEW: Professional Audio Analysis state

// Canvas for mixing
let canvas = document.createElement('canvas'); //
canvas.width = 1920; //
canvas.height = 1080; //
let ctx = canvas.getContext('2d'); //
let canvasStream = null; //
let mixerLayout = 'SOLO'; //
let activeGuestId = null; //

let overlayActive = false; //
let overlayImage = new Image(); //
let currentRawHTML = ""; //

const viewerPeers = {}; //
const callPeers = {}; //

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
    ? { iceServers: ICE_SERVERS } 
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; //

// ======================================================
// 3. CANVAS MIXER ENGINE (UPDATED: CPU Optimization)
// ======================================================

let lastDrawTime = 0;
const fpsInterval = 1000 / 30; // NEW: Target 30 FPS Lock

function drawMixer(timestamp) {
    requestAnimationFrame(drawMixer);

    // NEW: Frame Throttling Logic
    const elapsed = timestamp - lastDrawTime;
    if (elapsed < fpsInterval) return;
    lastDrawTime = timestamp - (elapsed % fpsInterval);

    if (!ctx) return; //
    
    ctx.fillStyle = '#000'; //
    ctx.fillRect(0, 0, canvas.width, canvas.height); //

    const myVideo = $('localVideo'); //
    
    let guestVideo = null; //
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`); //
        if (el) guestVideo = el.querySelector('video'); //
    }

    if (mixerLayout === 'SOLO') {
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height); //
        }
    } 
    else if (mixerLayout === 'GUEST') {
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height); //
        } else {
            ctx.fillStyle = '#333'; //
            ctx.fillRect(0, 0, canvas.width, canvas.height); //
            ctx.fillStyle = '#fff'; //
            ctx.font = "60px Arial"; //
            ctx.textAlign = "center"; //
            ctx.fillText("Waiting for Guest Signal...", canvas.width / 2, canvas.height / 2); //
        }
    } 
    else if (mixerLayout === 'SPLIT') {
        const participants = []; //
        if (myVideo && myVideo.readyState === 4) {
            participants.push(myVideo); //
        }

        Object.keys(callPeers).forEach(id => {
            const el = document.getElementById(`vid-${id}`); //
            if (el && el.querySelector('video') && el.querySelector('video').readyState === 4) {
                participants.push(el.querySelector('video')); //
            }
        });

        const count = participants.length || 1; //
        const slotW = canvas.width / count; //
        const aspect = 16 / 9; //
        const vidH = slotW / aspect; //
        const yOffset = (canvas.height - vidH) / 2; //

        participants.forEach((vid, i) => {
            ctx.drawImage(vid, i * slotW, yOffset, slotW, vidH); //
            if (i > 0) {
                ctx.strokeStyle = '#222'; //
                ctx.lineWidth = 4; //
                ctx.beginPath(); //
                ctx.moveTo(i * slotW, 0); //
                ctx.lineTo(i * slotW, canvas.height); //
                ctx.stroke(); //
            }
        });
    }
    else if (mixerLayout === 'PIP') {
        if (myVideo && myVideo.readyState === 4) {
            ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height); //
        }
        if (guestVideo && guestVideo.readyState === 4) {
            const pipW = 480, pipH = 270, padding = 30; //
            const x = canvas.width - pipW - padding; //
            const y = canvas.height - pipH - padding; //
            ctx.strokeStyle = "#4af3a3"; //
            ctx.lineWidth = 5; //
            ctx.strokeRect(x, y, pipW, pipH); //
            ctx.drawImage(guestVideo, x, y, pipW, pipH); //
        }
    }
    else if (mixerLayout === 'PIP_INVERTED') {
        if (guestVideo && guestVideo.readyState === 4) {
            ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height); //
        } else {
            ctx.fillStyle = '#111'; //
            ctx.fillRect(0, 0, canvas.width, canvas.height); //
        }
        if (myVideo && myVideo.readyState === 4) {
            const pipW = 480, pipH = 270, padding = 30; //
            const x = canvas.width - pipW - padding; //
            const y = canvas.height - pipH - padding; //
            ctx.strokeStyle = "#4af3a3"; //
            ctx.lineWidth = 5; //
            ctx.strokeRect(x, y, pipW, pipH); //
            ctx.drawImage(myVideo, x, y, pipW, pipH); //
        }
    }

    if (overlayActive && overlayImage.complete) {
        ctx.drawImage(overlayImage, 0, 0, canvas.width, canvas.height); //
    }
}

// ======================================================
// AUDIO ANALYSIS HELPERS (NEW PATCH)
// ======================================================
function setupAudioAnalysis(id, stream) {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        audioAnalysers[id] = {
            analyser,
            data: new Uint8Array(analyser.frequencyBinCount),
            vol: 0
        };
    } catch (e) { console.warn("Audio analysis init failed", e); }
}

// ======================================================
// BITRATE & STATS HELPERS (NEW PATCH)
// ======================================================
async function applyBitrateConstraints(pc) {
    const senders = pc.getSenders();
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
        try {
            const parameters = videoSender.getParameters();
            if (!parameters.encodings) parameters.encodings = [{}];
            parameters.encodings[0].maxBitrate = 2500 * 1000; // 2.5 Mbps cap
            await videoSender.setParameters(parameters);
        } catch (e) { console.error("Bitrate cap failed", e); }
    }
}

setInterval(async () => {
    for (const id in viewerPeers) {
        const pc = viewerPeers[id];
        if (pc.connectionState !== 'connected') continue;
        const stats = await pc.getStats();
        stats.forEach(report => {
            if (report.type === 'remote-inbound-rtp') {
                const badge = document.getElementById(`stats-${id}`);
                if (badge) {
                    const rtt = report.roundTripTime ? Math.round(report.roundTripTime * 1000) : 0;
                    const loss = report.fractionLost ? (report.fractionLost * 100).toFixed(1) : 0;
                    badge.innerHTML = `⏱️ ${rtt}ms | 📉 ${loss}%`;
                }
            }
        });
    }
}, 2000);

canvasStream = canvas.captureStream(30); //
requestAnimationFrame(drawMixer); //

// --- STREAM PREVIEW POPUP (HOST MONITOR) ---
const previewModal = $('streamPreviewModal'); //
const previewVideo = $('streamPreviewVideo'); //
const previewBtn = $('previewStreamBtn'); //
const closePreviewBtn = $('closePreviewBtn'); //

function openStreamPreview() {
    if (!canvasStream) {
        alert("Stream engine not initialized."); //
        return;
    }
    if (previewVideo) {
        previewVideo.srcObject = canvasStream; //
        previewVideo.muted = true; //
        previewVideo.play().catch(() => {}); //
    }
    if (previewModal) {
        previewModal.classList.add('active'); //
    }
}

function closeStreamPreview() {
    if (previewModal) {
        previewModal.classList.remove('active'); //
    }
    if (previewVideo) {
        previewVideo.srcObject = null; //
    }
}

if (previewBtn) previewBtn.addEventListener('click', openStreamPreview); //
if (closePreviewBtn) closePreviewBtn.addEventListener('click', closeStreamPreview); //
if (previewModal) {
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) closeStreamPreview(); //
    });
}

// --- HTML LAYOUT ENGINE WITH DYNAMIC STATS & CHAT ---
function buildChatHTMLFromLogs(maxLines = 12) {
    const log = $('chatLogPublic'); //
    if (!log) return ''; //

    const nodes = Array.from(log.querySelectorAll('.chat-line')); //
    const last = nodes.slice(-maxLines); //

    return last.map(line => {
        const nameEl = line.querySelector('strong'); //
        const timeEl = line.querySelector('small'); //
        let textNode = null; //
        for (const n of line.childNodes) {
            if (n.nodeType === Node.TEXT_NODE && n.textContent.includes(':')) {
                textNode = n; //
                break;
            }
        }

        const name = nameEl ? nameEl.textContent.trim() : ''; //
        const time = timeEl ? timeEl.textContent.trim() : ''; //
        const text = textNode
            ? textNode.textContent.replace(/^:\s*/, '').trim()
            : line.textContent.replace(name, '').trim(); //

        return `
            <div class="ov-chat-line">
               <span class="ov-chat-name">${name}</span>
               <span class="ov-chat-time">${time}</span>
               <span class="ov-chat-text">${text}</span>
            </div>
        `;
    }).join('');
}

function renderHTMLLayout(htmlString) {
    if (!htmlString) return; //
    currentRawHTML = htmlString; //

    // Separate Viewers from Guests for stats
    const viewerCount = latestUserList.filter(u => u.isViewer).length; //
    const guestCount = latestUserList.filter(u => !u.isViewer).length; //
    const streamTitle = $('streamTitleInput') ? $('streamTitleInput').value : "Rebel Stream"; //

    // Build chat HTML block from current public chat
    const chatHTML = buildChatHTMLFromLogs(14); //

    let processedHTML = htmlString
        .replace(/{{viewers}}/g, viewerCount)
        .replace(/{{guests}}/g, guestCount)
        .replace(/{{title}}/g, streamTitle)
        .replace(/{{chat}}/g, chatHTML); //

    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
            <foreignObject width="100%" height="100%">
                <div xmlns="http://www.w3.org/1999/xhtml" class="layout-${mixerLayout}" style="width:100%; height:100%; margin:0; padding:0;">
                    ${processedHTML}
                </div>
            </foreignObject>
        </svg>`; //

    try {
        overlayImage.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); //
        overlayActive = true; //
    } catch (e) {
        console.error("[Overlay] Failed to encode SVG", e); //
    }
}

window.setMixerLayout = (mode) => {
    mixerLayout = mode; //
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active'); //
        if (b.getAttribute('onclick') && b.getAttribute('onclick').includes(`'${mode}'`)) {
            b.classList.add('active'); //
        }
    });
    if (overlayActive) renderHTMLLayout(currentRawHTML); //
};

window.setActiveGuest = (id) => {
    activeGuestId = id; //
};

// ======================================================
// 4. TAB NAVIGATION INTERFACE
// ======================================================

const tabs = { 
    stream: $('tabStreamChat'), 
    room: $('tabRoomChat'), 
    files: $('tabFiles'), 
    users: $('tabUsers') 
}; //

const contents = { 
    stream: $('contentStreamChat'), 
    room: $('contentRoomChat'), 
    files: $('contentFiles'), 
    users: $('contentUsers') 
}; //

function switchTab(name) {
    if (!tabs[name]) return; //
    Object.values(tabs).forEach(t => t.classList.remove('active')); //
    Object.values(contents).forEach(c => c.classList.remove('active')); //
    tabs[name].classList.add('active'); //
    contents[name].classList.add('active'); //
    tabs[name].classList.remove('has-new'); //
}

if (tabs.stream) tabs.stream.onclick = () => switchTab('stream'); //
if (tabs.room)   tabs.room.onclick   = () => switchTab('room'); //
if (tabs.files)  tabs.files.onclick  = () => switchTab('files'); //
if (tabs.users)  tabs.users.onclick  = () => switchTab('users'); //

// ======================================================
// 5. DEVICE SETTINGS
// ======================================================

const settingsPanel = $('settingsPanel'); //
const audioSource   = $('audioSource'); //
const audioSource2  = $('audioSource2'); //
const videoSource   = $('videoSource'); //
const videoQuality  = $('videoQuality'); //

if ($('settingsBtn')) {
    $('settingsBtn').addEventListener('click', () => {
        const isHidden = settingsPanel.style.display === 'none' || settingsPanel.style.display === ''; //
        settingsPanel.style.display = isHidden ? 'block' : 'none'; //
        if (isHidden) getDevices(); //
    });
}

if ($('closeSettingsBtn')) {
    $('closeSettingsBtn').addEventListener('click', () => {
        settingsPanel.style.display = 'none'; //
    });
}

async function getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return; //
    try {
        const devices = await navigator.mediaDevices.enumerateDevices(); //
        if (audioSource)  audioSource.innerHTML = ''; 
        if (videoSource)  videoSource.innerHTML = ''; //
        if (audioSource2) audioSource2.innerHTML = '<option value="">-- None --</option>'; //

        devices.forEach(d => {
            const opt = document.createElement('option'); //
            opt.value = d.deviceId; //
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`; //
            if (d.kind === 'audioinput') {
                if (audioSource)  audioSource.appendChild(opt); //
                if (audioSource2) audioSource2.appendChild(opt.cloneNode(true)); //
            }
            if (d.kind === 'videoinput' && videoSource) videoSource.appendChild(opt); //
        });

        if (localStream) {
            const at = localStream.getAudioTracks()[0]; //
            const vt = localStream.getVideoTracks()[0]; //
            if (at && at.getSettings().deviceId && audioSource) audioSource.value = at.getSettings().deviceId; //
            if (vt && vt.getSettings().deviceId && videoSource) videoSource.value = vt.getSettings().deviceId; //
        }
    } catch (e) {
        console.error(e); //
    }
}

if (audioSource)  audioSource.onchange  = startLocalMedia; //
if (audioSource2) audioSource2.onchange = startLocalMedia; //
if (videoSource)  videoSource.onchange  = startLocalMedia; //
if (videoQuality) videoQuality.onchange = startLocalMedia; //

// ======================================================
// 6. MEDIA CONTROLS (UPDATED: High-Stability Constraints)
// ======================================================

async function startLocalMedia() {
    if (isScreenSharing) return; //

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop()); //
    }

    try {
        const quality = videoQuality ? videoQuality.value : 'ideal'; //
        let widthConstraint, heightConstraint; //

        if (quality === 'max') {
            widthConstraint  = { ideal: 1920 }; //
            heightConstraint = { ideal: 1080 }; //
        } else if (quality === 'low') {
            widthConstraint  = { ideal: 640 }; //
            heightConstraint = { ideal: 360 }; //
        } else {
            widthConstraint  = { ideal: 1280 }; //
            heightConstraint = { ideal: 720 }; //
        }

        const constraints = {
            audio: {
                deviceId: audioSource && audioSource.value
                    ? { exact: audioSource.value }
                    : undefined,
                echoCancellation: true,    // Professional stability patch
                noiseSuppression: true,
                autoGainControl: true
            },
            video: {
                deviceId: videoSource && videoSource.value
                    ? { exact: videoSource.value }
                    : undefined,
                width:  widthConstraint,
                height: heightConstraint,
                frameRate: { max: 30 }
            }
        }; //

        const mainStream = await navigator.mediaDevices.getUserMedia(constraints); //
        setupAudioAnalysis('local', mainStream); // Audio Patch

        let finalAudioTrack = mainStream.getAudioTracks()[0]; //

        const secondaryId = audioSource2 ? audioSource2.value : null; //
        if (secondaryId) {
            const secStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: secondaryId } }
            }); //
            if (!audioContext) audioContext = new AudioContext(); //
            audioDestination = audioContext.createMediaStreamDestination(); //

            const src1 = audioContext.createMediaStreamSource(mainStream); //
            const src2 = audioContext.createMediaStreamSource(secStream); //
            src1.connect(audioDestination); //
            src2.connect(audioDestination); //

            finalAudioTrack = audioDestination.stream.getAudioTracks()[0]; //
        }

        localStream = new MediaStream([
            mainStream.getVideoTracks()[0],
            finalAudioTrack
        ]); //

        const localVideo = $('localVideo'); //
        if (localVideo) {
            localVideo.srcObject = localStream; //
            localVideo.muted = true; //
        }

        const mixedVideoTrack = canvasStream.getVideoTracks()[0]; //

        const updateViewerPC = (pc) => {
            if (!pc) return; //
            const senders = pc.getSenders(); //
            const vSender = senders.find(s => s.track && s.track.kind === 'video'); //
            const aSender = senders.find(s => s.track && s.track.kind === 'audio'); //

            if (vSender && mixedVideoTrack) {
                vSender.replaceTrack(mixedVideoTrack); //
            }

            if (aSender && finalAudioTrack) {
                aSender.replaceTrack(finalAudioTrack); //
            }
        }; //

        Object.values(viewerPeers).forEach(updateViewerPC); //

        Object.values(callPeers).forEach(p => {
            const senders = p.pc.getSenders(); //
            const vSender = senders.find(s => s.track && s.track.kind === 'video'); //
            const aSender = senders.find(s => s.track && s.track.kind === 'audio'); //

            if (vSender && mainStream.getVideoTracks()[0]) {
                vSender.replaceTrack(mainStream.getVideoTracks()[0]); //
            }
            if (aSender && finalAudioTrack) {
                aSender.replaceTrack(finalAudioTrack); //
            }
        }); //

        const hangBtn = $('hangupBtn'); //
        if (hangBtn) hangBtn.disabled = false; //

        updateMediaButtons(); //

    } catch (e) {
        console.error(e); //
        alert("Camera/Mic access failed. Check permissions."); //
    }
}

function updateMediaButtons() {
    if (!localStream) return; //

    const vTrack = localStream.getVideoTracks()[0]; //
    const aTrack = localStream.getAudioTracks()[0]; //

    const camBtn = $('toggleCamBtn'); //
    const micBtn = $('toggleMicBtn'); //

    if (camBtn && vTrack) {
        const isCamOn = vTrack.enabled; //
        camBtn.textContent = isCamOn ? 'Camera On' : 'Camera Off'; //
        camBtn.classList.toggle('danger', !isCamOn); //
    }

    if (micBtn && aTrack) {
        const isMicOn = aTrack.enabled; //
        micBtn.textContent = isMicOn ? 'Mute' : 'Unmute'; //
        micBtn.classList.toggle('danger', !isMicOn); //
    }
}

const toggleMicBtn = $('toggleMicBtn'); //
if (toggleMicBtn) {
    toggleMicBtn.onclick = () => {
        if (!localStream) return; //
        const t = localStream.getAudioTracks()[0]; //
        if (t) {
            t.enabled = !t.enabled; //
            updateMediaButtons(); //
        }
    };
}

const toggleCamBtn = $('toggleCamBtn'); //
if (toggleCamBtn) {
    toggleCamBtn.onclick = () => {
        if (!localStream) return; //
        const t = localStream.getVideoTracks()[0]; //
        if (t) {
            t.enabled = !t.enabled; //
            updateMediaButtons(); //
        }
    };
}

// ======================================================
// 7. SCREEN SHARING
// ======================================================

const shareScreenBtn = $('shareScreenBtn'); //
if (shareScreenBtn) {
    shareScreenBtn.onclick = async () => {
        if (isScreenSharing) {
            stopScreenShare(); //
        } else {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                }); //
                isScreenSharing = true; //
                shareScreenBtn.textContent = 'Stop Screen'; //
                shareScreenBtn.classList.add('danger'); //

                const localVideo = $('localVideo'); //
                if (localVideo) {
                    localVideo.srcObject = screenStream; //
                }

                const st = screenStream.getVideoTracks()[0]; //
                const sa = screenStream.getAudioTracks()[0]; //

                Object.values(callPeers).forEach(p => {
                    p.pc.getSenders().forEach(s => {
                        if (s.track && s.track.kind === 'video' && st) {
                            s.replaceTrack(st); //
                        }
                        if (sa && s.track && s.track.kind === 'audio') {
                            s.replaceTrack(sa); //
                        }
                    });
                }); //

                st.onended = stopScreenShare; //

            } catch (e) {
                console.error(e); //
            }
        }
    };
}

function stopScreenShare() {
    if (!isScreenSharing) return; //
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop()); //
    }
    screenStream = null; //
    isScreenSharing = false; //

    const shareScreenBtn = $('shareScreenBtn'); //
    if (shareScreenBtn) {
        shareScreenBtn.textContent = 'Share Screen'; //
        shareScreenBtn.classList.remove('danger'); //
    }

    startLocalMedia(); //
}

// ======================================================
// 8. BROADCAST STREAMING
// ======================================================

async function handleStartStream() {
    if (!currentRoom || !iAmHost) return; //

    if (!localStream) {
        await startLocalMedia(); //
    }

    isStreaming = true; //
    const startBtn = $('startStreamBtn'); //
    if (startBtn) {
        startBtn.textContent = "Stop Stream"; //
        startBtn.classList.add('danger'); //
    }

    latestUserList.forEach(u => {
        if (u.id !== myId) {
            connectViewer(u.id); //
        }
    });
}

const startStreamBtn = $('startStreamBtn'); //
if (startStreamBtn) {
    startStreamBtn.onclick = async () => {
        if (!currentRoom || !iAmHost) {
            alert("Host only."); //
            return;
        }
        if (isStreaming) {
            isStreaming = false; //
            startStreamBtn.textContent = "Start Stream"; //
            startStreamBtn.classList.remove('danger'); //

            Object.values(viewerPeers).forEach(pc => pc.close()); //
            for (const k in viewerPeers) {
                delete viewerPeers[k]; //
            }
        } else {
            await handleStartStream(); //
        }
    };
}

// ======================================================
// 9. P2P CALLING (1-to-1)
// ======================================================

const hangupBtn = $('hangupBtn'); //
if (hangupBtn) {
    hangupBtn.onclick = () => {
        Object.keys(callPeers).forEach(id => endPeerCall(id)); //
    };
}

socket.on('ring-alert', async ({ from, fromId }) => {
    if (confirm(`Incoming call from ${from}. Accept?`)) {
        await callPeer(fromId); //
    }
});

// Listener for Viewer "Hand Raise" call requests
socket.on('call-request-received', ({ id, name }) => {
    const privateLog = $('chatLogPrivate'); //
    if (privateLog) {
        const div = document.createElement('div'); //
        div.className = 'chat-line system-msg'; //
        div.style.color = "var(--accent)"; //
        div.innerHTML = `<strong>✋ CALL REQUEST:</strong> ${name} wants to join the stream.`; //
        privateLog.appendChild(div); //
        privateLog.scrollTop = privateLog.scrollHeight; //
    }

    // NEW: behave like a call – give you a choice to ring them now
    const doRing = confirm(
        `${name} has requested to join the stream.\n\nRing them now?`
    ); //
    if (doRing && window.ringUser) {
        window.ringUser(id); //
    }

    renderUserList(); //
});

async function callPeer(targetId) {
    if (!localStream) {
        await startLocalMedia(); //
    }

    const pc = new RTCPeerConnection(iceConfig); //
    callPeers[targetId] = { pc, name: "Peer" }; //

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('call-ice', {
                targetId,
                candidate: e.candidate
            }); //
        }
    };

    pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]); //

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream)); //

    const offer = await pc.createOffer(); //
    await pc.setLocalDescription(offer); //

    socket.emit('call-offer', { targetId, offer }); //

    renderUserList(); //
}

socket.on('incoming-call', async ({ from, name, offer }) => {
    if (!localStream) {
        await startLocalMedia(); //
    }

    const pc = new RTCPeerConnection(iceConfig); //
    callPeers[from] = { pc, name }; //

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('call-ice', {
                targetId: from,
                candidate: e.candidate
            }); //
        }
    };

    pc.ontrack = e => addRemoteVideo(from, e.streams[0]); //

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream)); //

    await pc.setRemoteDescription(new RTCSessionDescription(offer)); //
    const answer = await pc.createAnswer(); //
    await pc.setLocalDescription(answer); //

    socket.emit('call-answer', { targetId: from, answer }); //

    renderUserList(); //
});

socket.on('call-answer', async ({ from, answer }) => {
    const peer = callPeers[from]; //
    if (!peer) return; //
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer)); //
});

socket.on('call-ice', async ({ from, candidate }) => {
    const peer = callPeers[from]; //
    if (!peer) return; //
    try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); //
    } catch (e) {
        console.error("Error adding ICE candidate to call peer", e); //
    }
});

function addRemoteVideo(id, stream) {
    const grid = $('videoGrid'); //
    if (!grid) return; //

    let existing = document.getElementById(`vid-${id}`); //
    if (!existing) {
        existing = document.createElement('div'); //
        existing.id = `vid-${id}`; //
        existing.className = 'video-container'; //
        existing.innerHTML = `
            <h2>Guest</h2>
            <video autoplay playsinline></video>
        `; //
        grid.appendChild(existing); //
    }

    const videoEl = existing.querySelector('video'); //
    if (videoEl) {
        videoEl.srcObject = stream; //
    }
}

function endPeerCall(id) {
    const peer = callPeers[id]; //
    if (!peer) return; //
    if (peer.pc) peer.pc.close(); //
    delete callPeers[id]; //

    const el = document.getElementById(`vid-${id}`); //
    if (el && el.parentNode) {
        el.parentNode.removeChild(el); //
    }

    renderUserList(); //
}

// ======================================================
// 10. VIEWER WEBRTC BRIDGE
// ======================================================

function createViewerPeer(targetId) {
    const pc = new RTCPeerConnection(iceConfig); //
    viewerPeers[targetId] = pc; //

    const mixedVideoTrack = canvasStream.getVideoTracks()[0]; //
    const audioTrack = localStream ? localStream.getAudioTracks()[0] : null; //

    if (mixedVideoTrack) {
        pc.addTrack(mixedVideoTrack, canvasStream); //
    }
    if (audioTrack) {
        pc.addTrack(audioTrack, localStream); //
    }

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', {
                targetId,
                candidate: e.candidate
            }); //
        }
    };

    applyBitrateConstraints(pc).catch(() => {}); //

    return pc; //
}

async function connectViewer(targetId) {
    if (!localStream || !canvasStream) {
        console.warn("No localStream/canvasStream yet for viewer connection"); //
        return;
    }

    let pc = viewerPeers[targetId]; //
    if (!pc) {
        pc = createViewerPeer(targetId); //
    }

    const offer = await pc.createOffer(); //
    await pc.setLocalDescription(offer); //

    socket.emit('webrtc-offer', {
        targetId,
        sdp: offer
    }); //
}

socket.on('webrtc-offer', async ({ sdp, from }) => {
    // Viewers won't hit this handler on host side
});

socket.on('webrtc-answer', async ({ sdp, from }) => {
    const pc = viewerPeers[from]; //
    if (!pc) return; //
    await pc.setRemoteDescription(new RTCSessionDescription(sdp)); //
});

socket.on('webrtc-ice-candidate', async ({ candidate, from }) => {
    const pc = viewerPeers[from]; //
    if (!pc) return; //
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate)); //
    } catch (e) {
        console.error("Error adding ICE candidate from viewer", e); //
    }
});

// When someone joins as viewer while stream is running
socket.on('viewer-joined', ({ id }) => {
    if (iAmHost && isStreaming) {
        connectViewer(id); //
    }
});

// ======================================================
// 11. ROOM & USER MANAGEMENT
// ======================================================

socket.on('connect', () => {
    myId = socket.id; //
});

socket.on('role', ({ isHost, streamTitle }) => {
    iAmHost = isHost; //
    wasHost = wasHost || isHost; //
    const header = $('headerTitle'); //
    if (header) {
        header.innerHTML = isHost
            ? `Rebel <span class="logo-highlight">Stream</span> <span class="host-badge">HOST</span>`
            : `Rebel <span class="logo-highlight">Stream</span>`; //
    }

    const hostControls = $('hostControls'); //
    if (hostControls) {
        hostControls.style.display = isHost ? 'block' : 'none'; //
    }

    const roomInfo = $('roomInfo'); //
    if (roomInfo && currentRoom) {
        roomInfo.textContent = isHost
            ? `👑 Host • Room: ${currentRoom}`
            : `👀 Connected • Room: ${currentRoom}`; //
    }

    const streamTitleInput = $('streamTitleInput'); //
    if (streamTitleInput && streamTitle) {
        streamTitleInput.value = streamTitle; //
    }
});

socket.on('room-update', ({ users, ownerId, locked, streamTitle }) => {
    latestUserList = users || []; //
    currentOwnerId = ownerId || null; //
    isPrivateMode = !!locked; //

    const lockBtn = $('lockRoomBtn'); //
    if (lockBtn) {
        lockBtn.textContent = locked ? '🔒 Room Locked' : '🔓 Lock Room'; //
        lockBtn.classList.toggle('danger', locked); //
    }

    const titleInput = $('streamTitleInput'); //
    if (titleInput && streamTitle) {
        titleInput.value = streamTitle; //
    }

    renderUserList(); //

    if (overlayActive && currentRawHTML) {
        renderHTMLLayout(currentRawHTML); //
    }
});

socket.on('user-joined', ({ id, name }) => {
    // Already handled via room-update, but we can log it
    const log = $('chatLogRoom'); //
    if (log) {
        const div = document.createElement('div'); //
        div.className = 'chat-line system-msg'; //
        div.textContent = `${name} joined the room.`; //
        log.appendChild(div); //
        log.scrollTop = log.scrollHeight; //
    }
});

socket.on('kicked', () => {
    alert("You were kicked from the room by the host."); //
    window.location.reload(); //
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

        // Auto-start camera + stream for host when joining a room
        startLocalMedia().then(() => {
            if (!isStreaming) {
                handleStartStream().catch(err => {
                    console.error('Auto start stream failed', err);
                });
            }
        }); //
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
            height: 128
        }); //
    }
}

function updateLink(room) {
    const url = `${window.location.origin}/view.html?room=${encodeURIComponent(room)}`; //
    const link = $('viewerLink'); //
    if (link) {
        link.textContent = url; //
        link.href = url; //
    }
    generateQR(url); //
}

// ======================================================
// 12. CHAT SYSTEM (STREAM / ROOM / DM)
// ======================================================

function appendChatLine(targetId, html) {
    const log = $(targetId); //
    if (!log) return; //
    const wrapper = document.createElement('div'); //
    wrapper.className = 'chat-line'; //
    wrapper.innerHTML = html; //
    log.appendChild(wrapper); //
    log.scrollTop = log.scrollHeight; //
}

function formatTime() {
    const d = new Date(); //
    return d.toTimeString().slice(0, 5); //
}

// Public stream chat
const streamChatInput = $('streamChatInput'); //
const streamChatSend  = $('streamChatSend'); //
if (streamChatSend && streamChatInput) {
    streamChatSend.onclick = () => {
        const msg = streamChatInput.value.trim(); //
        if (!msg || !currentRoom) return; //
        socket.emit('chat-stream', { room: currentRoom, user: userName, text: msg }); //
        streamChatInput.value = ''; //
    };
    streamChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') streamChatSend.onclick(); //
    });
}

socket.on('chat-stream', ({ user, text, time }) => {
    const stamp = time || formatTime(); //
    appendChatLine('chatLogPublic', `
        <strong>${user}</strong> <small>${stamp}</small>: ${text}
    `); //

    if (tabs.stream && !contents.stream.classList.contains('active')) {
        tabs.stream.classList.add('has-new'); //
    }

    if (overlayActive && currentRawHTML) {
        renderHTMLLayout(currentRawHTML); //
    }
});

// Room chat
const roomChatInput = $('roomChatInput'); //
const roomChatSend  = $('roomChatSend'); //
if (roomChatSend && roomChatInput) {
    roomChatSend.onclick = () => {
        const msg = roomChatInput.value.trim(); //
        if (!msg || !currentRoom) return; //
        socket.emit('chat-room', { room: currentRoom, user: userName, text: msg }); //
        roomChatInput.value = ''; //
    };
    roomChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') roomChatSend.onclick(); //
    });
}

socket.on('chat-room', ({ user, text, time }) => {
    const stamp = time || formatTime(); //
    appendChatLine('chatLogRoom', `
        <strong>${user}</strong> <small>${stamp}</small>: ${text}
    `); //

    if (tabs.room && !contents.room.classList.contains('active')) {
        tabs.room.classList.add('has-new'); //
    }
});

// Private (host-only) log
function logPrivateSystem(msg) {
    const log = $('chatLogPrivate'); //
    if (!log) return; //
    const div = document.createElement('div'); //
    div.className = 'chat-line system-msg'; //
    div.textContent = msg; //
    log.appendChild(div); //
    log.scrollTop = log.scrollHeight; //
}

// ======================================================
// 13. HOST CONTROLS: LOCKS, TITLES, VIP, ARCADE, OVERLAY
// ======================================================

const lockRoomBtn = $('lockRoomBtn'); //
if (lockRoomBtn) {
    lockRoomBtn.onclick = () => {
        if (!currentRoom || !iAmHost) return; //
        isPrivateMode = !isPrivateMode; //
        socket.emit('lock-room', isPrivateMode); //
    };
}

const streamTitleInput = $('streamTitleInput'); //
const updateTitleBtn = $('updateTitleBtn'); //
if (updateTitleBtn && streamTitleInput) {
    updateTitleBtn.onclick = () => {
        if (!currentRoom || !iAmHost) return; //
        const title = streamTitleInput.value.trim() || 'Untitled Stream'; //
        socket.emit('update-stream-title', title); //
        if (overlayActive && currentRawHTML) {
            renderHTMLLayout(currentRawHTML); //
        }
    };
}

const togglePrivateBtn = $('togglePrivateBtn'); //
const guestNameInput = $('guestNameInput'); //
const addGuestBtn = $('addGuestBtn'); //
const guestListPanel = $('guestListPanel'); //
const guestListDisplay = $('guestListDisplay'); //

if (togglePrivateBtn) {
    togglePrivateBtn.onclick = () => {
        isPrivateMode = !isPrivateMode; //
        togglePrivateBtn.textContent = isPrivateMode ? 'ON' : 'OFF'; //
        togglePrivateBtn.classList.toggle('danger', isPrivateMode); //
        if (guestListPanel) guestListPanel.style.display = isPrivateMode ? 'block' : 'none'; //
        socket.emit('lock-room', isPrivateMode); //
    };
}

if (addGuestBtn && guestNameInput) {
    addGuestBtn.onclick = () => {
        const name = guestNameInput.value.trim(); //
        if (!name) return; //
        allowedGuests.push(name.toLowerCase()); //
        guestNameInput.value = ''; //
        renderGuestList(); //
    };
}

function renderGuestList() {
    if (!guestListDisplay) return; //
    guestListDisplay.innerHTML = ''; //
    allowedGuests.forEach(n => {
        const tag = document.createElement('span'); //
        tag.className = 'guest-tag'; //
        tag.textContent = n; //
        guestListDisplay.appendChild(tag); //
    });
}

// Arcade loader
const arcadeInput = $('arcadeInput'); //
if (arcadeInput) {
    arcadeInput.onchange = () => {
        const file = arcadeInput.files[0]; //
        if (!file) return; //
        activeToolboxFile = file; //

        const status = $('arcadeStatus'); //
        if (status) {
            status.textContent = `Loaded: ${file.name}`; //
        }

        // Push to all current viewers if streaming
        if (isStreaming) {
            latestUserList.forEach(u => {
                if (u.id !== myId && u.isViewer) {
                    const pc = viewerPeers[u.id]; //
                    if (pc) {
                        logPrivateSystem(`Sending toolbox "${file.name}" to ${u.name}...`); //
                        pushFileToPeer(pc, file, (p) => {
                            // Optionally show progress somewhere
                        }); //
                    }
                }
            });
        }
    };
}

// HTML overlay loader
const htmlOverlayInput = $('htmlOverlayInput'); //
if (htmlOverlayInput) {
    htmlOverlayInput.onchange = () => {
        const file = htmlOverlayInput.files[0]; //
        if (!file) return; //
        const reader = new FileReader(); //
        reader.onload = (e) => {
            const html = e.target.result; //
            renderHTMLLayout(html); //
            const status = $('overlayStatus'); //
            if (status) status.textContent = `Loaded: ${file.name}`; //
        };
        reader.readAsText(file); //
    };
}

window.clearOverlay = () => {
    overlayActive = false; //
    currentRawHTML = ""; //
    const status = $('overlayStatus'); //
    if (status) status.textContent = '[No Overlay]'; //
};

// ======================================================
// 14. USER LIST PANEL & ACTIONS
// ======================================================

function renderUserList() {
    const wrap = $('userList'); //
    if (!wrap) return; //
    wrap.innerHTML = ''; //

    latestUserList.forEach(u => {
        const row = document.createElement('div'); //
        row.className = 'user-row'; //

        const isOwner = currentOwnerId === u.id; //
        const isSelf = u.id === myId; //

        let badges = ''; //
        if (isOwner) badges += '👑 '; //
        if (u.isViewer) badges += '👀 '; //
        if (u.requestingCall) badges += '✋ '; //

        row.innerHTML = `
            <div class="user-main">
              <span class="user-name">${badges}${u.name}</span>
            </div>
            <div class="user-actions"></div>
        `; //

        const actions = row.querySelector('.user-actions'); //

        if (iAmHost && !isSelf) {
            const kickBtn = document.createElement('button'); //
            kickBtn.className = 'btn small danger'; //
            kickBtn.textContent = 'Kick'; //
            kickBtn.onclick = () => {
                if (confirm(`Kick ${u.name}?`)) {
                    socket.emit('kick-user', u.id); //
                }
            };
            actions.appendChild(kickBtn); //

            const callBtn = document.createElement('button'); //
            callBtn.className = 'btn small'; //
            callBtn.textContent = 'Call'; //
            callBtn.onclick = () => {
                window.ringUser(u.id); //
            };
            actions.appendChild(callBtn); //

            const hostBtn = document.createElement('button'); //
            hostBtn.className = 'btn small secondary'; //
            hostBtn.textContent = 'Make Host'; //
            hostBtn.onclick = () => {
                if (confirm(`Give host control to ${u.name}?`)) {
                    socket.emit('promote-to-host', { targetId: u.id }); //
                }
            };
            actions.appendChild(hostBtn); //
        }

        if (!u.isViewer && !isSelf) {
            const muteBtn = document.createElement('button'); //
            muteBtn.className = 'btn small secondary'; //
            muteBtn.textContent = mutedUsers.has(u.id) ? 'Unmute' : 'Mute'; //
            muteBtn.onclick = () => {
                if (mutedUsers.has(u.id)) mutedUsers.delete(u.id);
                else mutedUsers.add(u.id);
                muteBtn.textContent = mutedUsers.has(u.id) ? 'Unmute' : 'Mute'; //
            };
            actions.appendChild(muteBtn); //
        }

        if (u.id !== myId) {
            const statsBadge = document.createElement('span'); //
            statsBadge.id = `stats-${u.id}`; //
            statsBadge.className = 'stats-badge'; //
            statsBadge.textContent = ''; //
            actions.appendChild(statsBadge); //
        }

        wrap.appendChild(row); //
    });
}

window.ringUser = (id) => {
    socket.emit('ring-user', id); //
};

// ======================================================
// 15. SIGNAL STATUS
// ======================================================

socket.on('connect', () => {
    const signalStatus = $('signalStatus'); //
    if (signalStatus) {
        signalStatus.className = 'status-dot status-connected'; //
        signalStatus.textContent = 'Connected'; //
    }
});

socket.on('disconnect', () => {
    const signalStatus = $('signalStatus'); //
    if (signalStatus) {
        signalStatus.className = 'status-dot status-disconnected'; //
        signalStatus.textContent = 'Disconnected'; //
    }
});

// ======================================================
// END
// ======================================================
