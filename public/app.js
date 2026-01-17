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

function setupArcadeReceiver(pc) {
    pc.ondatachannel = (e) => {
        if (e.channel.label !== "side-load-pipe") return; //
        const chan = e.channel; //
        let chunks = []; //
        let total = 0; //
        let curr = 0; //
        let meta = null; //

        chan.onmessage = (evt) => {
            if (typeof evt.data === 'string') {
                try {
                    meta = JSON.parse(evt.data); //
                    total = meta.size; //
                } catch (e) {
                    console.error(e); //
                }
            } else {
                chunks.push(evt.data); //
                curr += evt.data.byteLength; //
                if (curr >= total) {
                    const blob = new Blob(chunks, { type: meta ? meta.mime : 'application/octet-stream' }); //
                    const url = URL.createObjectURL(blob); //
                    addToolToChat(url, meta ? meta.name : 'Tool'); //
                    chan.close(); //
                }
            }
        };
    };
}

function addToolToChat(url, name) {
    const log = $('chatLogPublic'); //
    if (!log) return; //
    const div = document.createElement('div'); //
    div.className = 'chat-line system-msg'; //
    div.innerHTML = `
        <div style="background:rgba(74,243,163,0.1); border:1px solid #4af3a3; padding:10px; border-radius:8px; text-align:center; margin: 10px 0;">
            <div style="color:#4af3a3; font-weight:bold; margin-bottom:5px;">🚀 TOOL RECEIVED: ${name}</div>
            <a href="${url}" download="${name}" style="background:#4af3a3; color:#000; padding:6px 12px; border-radius:4px; display:inline-block; text-decoration:none; font-weight:bold; font-size:0.8rem;">DOWNLOAD</a>
        </div>`; //
    log.appendChild(div); //
    log.scrollTop = log.scrollHeight; //
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
let mutedAudioIds = new Set(); //

let localStream = null; //
let screenStream = null; //
let isScreenSharing = false; //
let isStreaming = false; //

let activeToolboxFile = null; //

let audioContext = null; //
let audioDestination = null; //

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
// 3. CANVAS MIXER ENGINE (The "Broadcast" Logic)
// ======================================================

function drawMixer() {
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

    requestAnimationFrame(drawMixer); //
}

canvasStream = canvas.captureStream(30); //
drawMixer(); //

function updateRoomInfo() {
    const roomInfo = $('roomInfo'); //
    if (!roomInfo) return; //
    if (!currentRoom) {
        roomInfo.textContent = ''; //
        return; //
    }
    const viewers = latestUserList.filter(u => u.isViewer).length; //
    const guests = latestUserList.filter(u => !u.isViewer).length; //
    const hostName = latestUserList.find(u => u.id === currentOwnerId)?.name; //
    roomInfo.textContent = `Room: ${currentRoom} • Viewers: ${viewers} • Guests: ${guests}${hostName ? ` • Host: ${hostName}` : ''}`; //
}

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

// --- HTML LAYOUT ENGINE WITH DYNAMIC STATS ---
function renderHTMLLayout(htmlString) {
    if (!htmlString) return; //
    currentRawHTML = htmlString; //

    // Separate Viewers from Guests for stats
    const viewerCount = latestUserList.filter(u => u.isViewer).length; //
    const guestCount = latestUserList.filter(u => !u.isViewer).length; //
    const streamTitle = $('streamTitleInput') ? $('streamTitleInput').value : "Rebel Stream"; //

    let processedHTML = htmlString
        .replace(/{{viewers}}/g, viewerCount)
        .replace(/{{guests}}/g, guestCount)
        .replace(/{{title}}/g, streamTitle); //

    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
            <foreignObject width="100%" height="100%">
                <div xmlns="http://www.w3.org/1999/xhtml" class="layout-${mixerLayout}" style="width:100%; height:100%; margin:0; padding:0;">
                    ${processedHTML}
                </div>
            </foreignObject>
        </svg>`; //

    overlayImage.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); //
    overlayActive = true; //
}

window.setMixerLayout = (mode) => {
    mixerLayout = mode; //
    document.querySelectorAll('.mixer-btn').forEach(b => {
        b.classList.remove('active'); //
        if (b.getAttribute('onclick').includes(`'${mode}'`)) {
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
        audioSource.innerHTML = ''; 
        videoSource.innerHTML = ''; //
        if (audioSource2) audioSource2.innerHTML = '<option value="">-- None --</option>'; //

        devices.forEach(d => {
            const opt = document.createElement('option'); //
            opt.value = d.deviceId; //
            opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`; //
            if (d.kind === 'audioinput') {
                audioSource.appendChild(opt); //
                if (audioSource2) audioSource2.appendChild(opt.cloneNode(true)); //
            }
            if (d.kind === 'videoinput') videoSource.appendChild(opt); //
        });

        if (localStream) {
            const at = localStream.getAudioTracks()[0]; //
            const vt = localStream.getVideoTracks()[0]; //
            if (at && at.getSettings().deviceId) audioSource.value = at.getSettings().deviceId; //
            if (vt && vt.getSettings().deviceId) videoSource.value = vt.getSettings().deviceId; //
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
// 6. MEDIA CONTROLS
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
                    : undefined
            },
            video: {
                deviceId: videoSource && videoSource.value
                    ? { exact: videoSource.value }
                    : undefined,
                width:  widthConstraint,
                height: heightConstraint
            }
        }; //

        const mainStream = await navigator.mediaDevices.getUserMedia(constraints); //
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
            localVideo.play().catch(() => {}); //
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
        if (u.id !== myId && u.isViewer) {
            connectViewer(u.id); //
        }
    });

    socket.emit('stream-status', { room: currentRoom, live: true }); //
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
            socket.emit('stream-status', { room: currentRoom, live: false }); //
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
    renderUserList(); //
});

async function callPeer(targetId) {
    if (!localStream) {
        await startLocalMedia(); //
    }

    const pc = new RTCPeerConnection(iceConfig); //
    setupArcadeReceiver(pc); //
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
    setupArcadeReceiver(pc); //
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

    await pc.setRemoteDescription(new RTCSessionDescription(offer)); //

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream)); //

    const answer = await pc.createAnswer(); //
    await pc.setLocalDescription(answer); //

    socket.emit('call-answer', { targetId: from, answer }); //

    renderUserList(); //
});

socket.on('call-answer', async ({ from, answer }) => {
    if (callPeers[from]) {
        await callPeers[from].pc.setRemoteDescription(
            new RTCSessionDescription(answer)
        ); //
    }
});

socket.on('call-ice', ({ from, candidate }) => {
    if (callPeers[from]) {
        callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)); //
    }
});

socket.on('call-end', ({ from }) => {
    endPeerCall(from, true); //
});

function endPeerCall(id, isIncomingSignal) {
    if (callPeers[id]) {
        try {
            callPeers[id].pc.close(); //
        } catch (e) {
            console.error(e); //
        }
    }
    delete callPeers[id]; //
    removeRemoteVideo(id); //
    mutedAudioIds.delete(id); //
    if (activeGuestId === id) {
        activeGuestId = null; //
        window.setMixerLayout('SOLO'); //
    }

    if (!isIncomingSignal) {
        socket.emit('call-end', { targetId: id }); //
    }

    renderUserList(); //
}

// ======================================================
// 10. VIEWER CONNECTION & ARCADE PUSH
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
    if (currentRoom) {
        socket.emit('join-room', { room: currentRoom, name: userName, isViewer: false }); //
    }
});

socket.on('disconnect', () => {
    const signalStatus = $('signalStatus'); //
    if (signalStatus) {
        signalStatus.className = 'status-dot status-disconnected'; //
        signalStatus.textContent = 'Disconnected'; //
    }
    Object.values(viewerPeers).forEach(pc => pc.close()); //
    for (const k in viewerPeers) {
        delete viewerPeers[k]; //
    }
    Object.keys(callPeers).forEach(id => {
        try {
            callPeers[id].pc.close(); //
        } catch (e) {
            console.error(e); //
        }
        removeRemoteVideo(id); //
        delete callPeers[id]; //
    });
    updateRoomInfo(); //
});

function joinRoom(room, name) {
    if (!room) return; //
    currentRoom = room; //
    userName = name && name.trim() ? name.trim() : 'Host'; //

    if (!socket.connected) {
        socket.connect(); //
    }
    socket.emit('join-room', { room, name: userName, isViewer: false }); //

    if (joinBtn) joinBtn.disabled = true; //
    const leaveBtn = $('leaveBtn'); //
    if (leaveBtn) leaveBtn.disabled = false; //

    updateLink(room); //
    updateRoomInfo(); //
    startLocalMedia(); //
}

const joinBtn = $('joinBtn'); //
if (joinBtn) {
    joinBtn.onclick = () => {
        const room = $('roomInput').value.trim(); //
        if (!room) return;
        const nameInput = $('nameInput'); //
        joinRoom(room, nameInput ? nameInput.value : 'Host'); //
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

socket.on('user-joined', ({ id, name, isViewer }) => {
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

    if (iAmHost && isStreaming && isViewer) {
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
    updateRoomInfo(); //

    if (iAmHost && isStreaming) {
        latestUserList.forEach(u => {
            if (u.id !== myId && u.isViewer) {
                connectViewer(u.id); //
            }
        }); //
    }
    
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

const params = new URLSearchParams(window.location.search); //
const autoRoom = params.get('room'); //
const autoName = params.get('name'); //
const autoJoin = ['1', 'true', 'yes'].includes((params.get('autojoin') || '').toLowerCase()); //

if (autoRoom) {
    const roomInput = $('roomInput'); //
    if (roomInput) roomInput.value = autoRoom; //
    const nameInput = $('nameInput'); //
    if (nameInput && autoName) nameInput.value = autoName; //
    updateLink(autoRoom); //
}

if (autoRoom && autoJoin) {
    joinRoom(autoRoom, autoName || 'Guest'); //
}

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
        if (!s) return; //
        if (currentRoom && socket.connected && currentRoom !== s) {
            alert("Room is live. Leave and rejoin to change the slug."); //
            return; //
        }
        const roomInput = $('roomInput'); //
        if (roomInput) roomInput.value = s; //
        currentRoom = s; //
        updateLink(s); //
    };
}

const slugInput = $('slugInput'); //
if (slugInput) {
    slugInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            const s = slugInput.value.trim(); //
            if (!s) return; //
            if (currentRoom && socket.connected && currentRoom !== s) {
                alert("Room is live. Leave and rejoin to change the slug."); //
                return; //
            }
            const roomInput = $('roomInput'); //
            if (roomInput) roomInput.value = s; //
            currentRoom = s; //
            updateLink(s); //
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

    socket.emit('public-chat', {
        room: currentRoom,
        name: userName,
        text: t
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
    const log = $('chatLogPublic'); //
    appendChat(log, d.name, d.text, d.ts); //
    if (tabs.stream && !tabs.stream.classList.contains('active')) {
        tabs.stream.classList.add('has-new'); //
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

        sendArcadeToAll(); //
    };
}

const arcadeStatus = $('arcadeStatus'); //
if (arcadeStatus) {
    arcadeStatus.onclick = () => {
        if (!activeToolboxFile) return; //
        sendArcadeToAll(); //
    };
}

const htmlOverlayInput = $('htmlOverlayInput'); //
if (htmlOverlayInput) {
    htmlOverlayInput.onchange = (e) => {
        const f = e.target.files[0]; //
        if (!f) return; //

        const r = new FileReader(); //
        r.onload = (ev) => {
            renderHTMLLayout(ev.target.result); //
            const overlayStatus = $('overlayStatus'); //
            if (overlayStatus) overlayStatus.textContent = "[Loaded]"; //
        };
        r.readAsText(f); //
    };
}

window.clearOverlay = () => {
    overlayActive = false; //
    overlayImage = new Image(); //
    const overlayStatus = $('overlayStatus'); //
    if (overlayStatus) overlayStatus.textContent = "[Empty]"; //
};

// ======================================================
// 16. USER LIST & MIXER SELECTION
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
            const roleTags = []; //
            if (u.id === currentOwnerId) {
                nameSpan.textContent = '👑 '; //
                roleTags.push('Host'); //
            } else if (u.isViewer) {
                roleTags.push('Viewer'); //
            } else {
                roleTags.push('Guest'); //
            }
            if (activeGuestId === u.id) {
                roleTags.push('Live'); //
            }
            nameSpan.textContent += u.name; //
            if (roleTags.length) {
                nameSpan.textContent += ` (${roleTags.join(', ')})`; //
            }
            if (u.requestingCall) {
                const requestBadge = document.createElement('span'); //
                requestBadge.title = 'Requesting to Join Stream'; //
                requestBadge.textContent = ' ✋'; //
                nameSpan.appendChild(requestBadge); //
            }

            const actions = document.createElement('div'); //
            actions.className = 'user-actions'; //

            const isCalling = !!callPeers[u.id]; //

            if (iAmHost) {
                const mBtn = document.createElement('button'); //
                mBtn.className = 'action-btn'; //
                const isMuted = mutedAudioIds.has(u.id); //
                mBtn.textContent = isMuted ? 'Unmute Audio' : 'Mute Audio'; //
                mBtn.onclick = () => {
                    if (isMuted) {
                        mutedAudioIds.delete(u.id); //
                        setRemoteAudioMuted(u.id, false); //
                    } else {
                        mutedAudioIds.add(u.id); //
                        setRemoteAudioMuted(u.id, true); //
                    }
                    renderUserList(); //
                };
                actions.appendChild(mBtn); //

                const callBtn = document.createElement('button'); //
                callBtn.className = 'action-btn'; //
                if (isCalling) {
                    callBtn.textContent = 'End'; //
                    callBtn.style.color = 'var(--danger)'; //
                    callBtn.onclick = () => endPeerCall(u.id); //
                } else {
                    callBtn.textContent = u.requestingCall ? 'Accept & Call' : 'Call'; //
                    if (u.requestingCall) callBtn.style.borderColor = "var(--accent)"; //
                    callBtn.onclick = () => window.ringUser(u.id); //
                }
                actions.appendChild(callBtn); //
            }

            if (isCalling && iAmHost) {
                const selBtn = document.createElement('button'); //
                selBtn.className = 'action-btn'; //
                selBtn.textContent = (activeGuestId === u.id) ? 'Unmix' : 'Mix'; //
                selBtn.onclick = () => {
                    activeGuestId = (activeGuestId === u.id) ? null : u.id; //
                    renderUserList(); //
                    window.setActiveGuest(activeGuestId); //
                    if (!activeGuestId) {
                        window.setMixerLayout('SOLO'); //
                    }
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

                if (u.requestingCall) {
                    const dBtn = document.createElement('button'); //
                    dBtn.className = 'action-btn kick'; //
                    dBtn.textContent = 'Decline'; //
                    dBtn.onclick = () => {
                        socket.emit('respond-to-call-request', { targetId: u.id, approved: false }); //
                    };
                    actions.appendChild(dBtn); //
                }

                if (activeToolboxFile) {
                    const tBtn = document.createElement('button'); //
                    tBtn.className = 'action-btn'; //
                    tBtn.textContent = 'Send Tool'; //
                    tBtn.onclick = () => sendArcadeToUser(u.id, u.name); //
                    actions.appendChild(tBtn); //
                }
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
    }
    if (mutedAudioIds.has(id)) {
        v.muted = true; //
    }
}

function removeRemoteVideo(id) {
    const el = document.getElementById(`vid-${id}`); //
    if (el) el.remove(); //
}

function setRemoteAudioMuted(id, muted) {
    const el = document.getElementById(`vid-${id}`); //
    if (!el) return; //
    const video = el.querySelector('video'); //
    if (video) video.muted = muted; //
}

function sendArcadeToAll() {
    if (!activeToolboxFile) return; //
    Object.keys(viewerPeers).forEach(id => {
        pushFileToPeer(viewerPeers[id], activeToolboxFile); //
    }); //
    Object.keys(callPeers).forEach(id => {
        pushFileToPeer(callPeers[id].pc, activeToolboxFile); //
    }); //
    if (currentRoom) {
        socket.emit('public-chat', {
            room: currentRoom,
            name: userName,
            text: `📦 Sent tool to everyone: ${activeToolboxFile.name}`
        }); //
    }
}

function sendArcadeToUser(targetId, targetName) {
    if (!activeToolboxFile) return; //
    const viewerPc = viewerPeers[targetId]; //
    const callPc = callPeers[targetId]?.pc; //
    const pc = viewerPc || callPc; //
    if (!pc) {
        alert("User is not connected for toolbox transfer yet."); //
        return;
    }
    pushFileToPeer(pc, activeToolboxFile); //
    if (currentRoom) {
        socket.emit('public-chat', {
            room: currentRoom,
            name: userName,
            text: `📦 Sent tool to ${targetName}: ${activeToolboxFile.name}`
        }); //
    }
}

window.ringUser = (id) => socket.emit('ring-user', id); //
window.endPeerCall = endPeerCall; //
window.kickUser = (id) => socket.emit('kick-user', id); //

const openStreamBtn = $('openStreamBtn'); //
if (openStreamBtn) {
    openStreamBtn.onclick = () => {
        const u = $('streamLinkInput') && $('streamLinkInput').value; //
        if (!u) return; //
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(u).catch(() => {}); //
        }
        window.open(u, '_blank'); //
    };
}
