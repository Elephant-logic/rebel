// HOST – RESTARTABLE BROADCAST 
const socket = io({
    autoConnect: false
});

let currentRoom = null;
let userName = 'Host';

let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;

// ICE config (you can also override via ICE_SERVERS in ice.js) 
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? {
    iceServers: ICE_SERVERS
} : {
    iceServers: [{
        urls: 'stun:stun.l.google.com:19302'
    }]
};

// DOM 
const $ = id => document.getElementById(id);

const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const startCallBtn = $('startCallBtn');
const startStreamBtn = $('startStreamBtn');
const hangupBtn = $('hangupBtn');
const shareScreenBtn = $('shareScreenBtn');
const toggleCamBtn = $('toggleCamBtn');
const toggleMicBtn = $('toggleMicBtn');
const localVideo = $('localVideo');
const streamLinkInput = $('streamLinkInput');
const openStreamBtn = $('openStreamBtn');
const signalStatus = $('signalStatus');
const roomInfo = $('roomInfo');

// Chat & file 
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const emojiStrip = $('emojiStrip');
const fileInput = $('fileInput');
const sendFileBtn = $('sendFileBtn');
const fileNameLabel = $('fileNameLabel');

// ---------- Helpers ---------- 
function setSignal(connected) {
    if (!signalStatus) return;
    signalStatus.textContent = connected ? 'Connected' : 'Disconnected';
    signalStatus.className = connected ? 'status-dot status-connected' : 'status-dot status-disconnected';
}

function appendChat(name, text, ts = Date.now()) {
    if (!chatLog) return;
    const line = document.createElement('div');
    line.className = 'chat-line';

    const t = new Date(ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });
    const nameHtml = name === 'You'
        ? `<span style="color:#4af3a3">${name}</span>`
        : `<strong>${name}</strong>`;
    line.innerHTML = `${nameHtml} <small>${t}</small>: ${text}`;
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------- Media helpers ---------- 
async function ensureLocalStream() {
    if (localStream) return localStream;
    userName = (nameInput && nameInput.value.trim()) || 'Host';
    localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
    });
    if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.muted = true;
    }
    return localStream;
}

// ---------- WebRTC (host) ---------- 
function createHostPC() {
    if (pc) {
        try {
            pc.close();
        } catch (e) {}
        pc = null;
    }
    pc = new RTCPeerConnection(iceConfig);

    pc.onicecandidate = (event) => {
        if (event.candidate && currentRoom) {
            socket.emit('webrtc-ice-candidate', {
                room: currentRoom,
                candidate: event.candidate
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('Host PC state:', pc.connectionState);
    };
}

async function startBroadcast() {
    if (!currentRoom) {
        alert('Join a room first');
        return;
    }

    const stream = isScreenSharing && screenStream ? screenStream : await ensureLocalStream();

    createHostPC();

    // attach tracks 
    pc.getSenders().forEach(s => pc.removeTrack(s));
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('webrtc-offer', {
        room: currentRoom,
        sdp: offer
    });

    if (startCallBtn) {
        startCallBtn.disabled = true;
        startCallBtn.textContent = 'Streaming…';
    }
    if (startStreamBtn) {
        startStreamBtn.disabled = true;
        startStreamBtn.textContent = 'Streaming…';
    }
    if (hangupBtn) hangupBtn.disabled = false;
}

function stopBroadcast() {
    if (pc) {
        try {
            pc.close();
        } catch (e) {}
        pc = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }
    localStream = null;
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
    }
    screenStream = null;
    isScreenSharing = false;
    if (localVideo) localVideo.srcObject = null;

    if (startCallBtn) {
        startCallBtn.disabled = false;
        startCallBtn.textContent = 'Start Call';
    }
    if (startStreamBtn) {
        startStreamBtn.disabled = false;
        startStreamBtn.textContent = 'Start Stream';
    }
    if (hangupBtn) hangupBtn.disabled = true;
}

// ---------- Join / leave room ---------- 
if (joinBtn) {
    joinBtn.addEventListener('click', () => {
        const room = roomInput && roomInput.value.trim();
        if (!room) return alert('Enter room');
        currentRoom = room;
        userName = (nameInput && nameInput.value.trim()) || 'Host';

        socket.connect();
        socket.emit('join-room', {
            room: currentRoom,
            name: userName
        });

        joinBtn.disabled = true;
        if (leaveBtn) leaveBtn.disabled = false;
        if (roomInfo) roomInfo.textContent = `Room: ${room}`;

        const url = new URL(window.location.href);
        url.pathname = '/view.html';
        url.search = `?room=${encodeURIComponent(room)}`;
        if (streamLinkInput) streamLinkInput.value = url.toString();
    });
}

if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
        stopBroadcast();
        socket.disconnect();
        window.location.reload();
    });
}

if (startCallBtn) {
    startCallBtn.addEventListener('click', () => {
        startBroadcast().catch(console.error);
    });
}

if (startStreamBtn) {
    startStreamBtn.addEventListener('click', () => {
        startBroadcast().catch(console.error);
    });
}

if (hangupBtn) {
    hangupBtn.addEventListener('click', () => {
        stopBroadcast();
    });
}

// ---------- Screen share ---------- 
if (shareScreenBtn) {
    shareScreenBtn.addEventListener('click', async () => {
        if (!currentRoom) return alert('Join a room first');
        await ensureLocalStream();
        if (!pc) await startBroadcast();
        if (!isScreenSharing) {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: false
                });
                const track = screenStream.getVideoTracks()[0];
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(track);
                if (localVideo) localVideo.srcObject = screenStream;
                isScreenSharing = true;
                shareScreenBtn.textContent = 'Stop Screen';
                track.onended = () => {
                    stopScreenShare();
                };
            } catch (e) {
                console.error('getDisplayMedia error:', e);
            }
        } else {
            stopScreenShare();
        }
    });
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    isScreenSharing = false;
    if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender && camTrack) sender.replaceTrack(camTrack);
        if (localVideo) localVideo.srcObject = localStream;
    }
    if (shareScreenBtn) shareScreenBtn.textContent = 'Share Screen';
}

// ---------- Chat ---------- 
if (sendBtn && chatInput) {
    sendBtn.addEventListener('click', () => {
        const text = chatInput.value.trim();
        if (!text || !currentRoom) return;
        socket.emit('chat-message', {
            room: currentRoom,
            name: userName,
            text
        });
        appendChat('You', text);
        chatInput.value = '';
    });
    chatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            sendBtn.click();
        }
    });
}

socket.on('chat-message', ({
    name,
    text,
    ts
}) => {
    appendChat(name, text, ts || Date.now());
});

// emojis 
if (emojiStrip && chatInput) {
    emojiStrip.addEventListener('click', e => {
        if (e.target.classList.contains('emoji')) {
            chatInput.value += e.target.textContent;
            chatInput.focus();
        }
    });
}

// ---------- File sharing ---------- 
if (fileInput && sendFileBtn) {
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (fileNameLabel) fileNameLabel.textContent = file ? file.name : 'No file';
        sendFileBtn.disabled = !file;
    });

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
            const href = `data:${file.type};base64,${base64}`;
            const link = `<a href="${href}" download="${file.name}" style="color:#4af3a3">📁 ${file.name}</a>`;
            appendChat('You', `Sent file: ${link}`);
            fileInput.value = '';
            if (fileNameLabel) fileNameLabel.textContent = 'No file';
            sendFileBtn.disabled = true;
        };
        reader.readAsDataURL(file);
    });
}

socket.on('file-share', ({
    name,
    fileName,
    fileType,
    fileData
}) => {
    const href = `data:${fileType};base64,${fileData}`;
    const link = `<a href="${href}" download="${fileName}" style="color:#4af3a3">📁 ${fileName}</a>`;
    appendChat(name, `Sent file: ${link}`);
});

// ---------- Socket status ---------- 
socket.on('connect', () => setSignal(true));
socket.on('disconnect', () => setSignal(false));
