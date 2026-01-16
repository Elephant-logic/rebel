const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
    ? { iceServers: ICE_SERVERS }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;              // stream PC (host → viewer)
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random() * 1000);

// ==========================================
// 1. ARCADE RECEIVER (Game -> Chat Logic)
// ==========================================
function setupReceiver(pc) {
    pc.ondatachannel = (e) => {
        if (e.channel.label !== "side-load-pipe") return;
        const chan = e.channel;
        let chunks = [], total = 0, curr = 0, meta = null;

        chan.onmessage = (ev) => {
            if (!meta) {
                try {
                    meta = JSON.parse(ev.data);
                    if (meta.type !== 'meta') meta = null;
                    return;
                } catch {
                    meta = null;
                    return;
                }
            }

            const chunk = ev.data;
            chunks.push(chunk);
            curr += chunk.byteLength;

            if (curr >= meta.size) {
                const blob = new Blob(chunks, { type: meta.mime || 'application/octet-stream' });
                const url = URL.createObjectURL(blob);

                const toolbox = $('toolboxContainer');
                if (toolbox) {
                    const card = document.createElement('div');
                    card.className = 'toolbox-card';

                    const title = document.createElement('div');
                    title.className = 'toolbox-title';
                    title.textContent = meta.name || 'Received Tool';

                    const actions = document.createElement('div');
                    actions.className = 'toolbox-actions';

                    const download = document.createElement('a');
                    download.href = url;
                    download.download = meta.name || 'download.bin';
                    download.textContent = 'Download';
                    download.className = 'btn-ctrl';

                    actions.appendChild(download);
                    card.appendChild(title);
                    card.appendChild(actions);
                    toolbox.appendChild(card);
                }

                meta = null;
                chunks = [];
                curr = 0;
            }
        };
    };
}

// ==========================================
// 2. STREAM SETUP (Host → Viewer Video)
// ==========================================
async function joinAsViewer(room) {
    currentRoom = room;
    socket.connect();
    socket.emit('join-room', { room, name: myName, isViewer: true });
}

socket.on('connect', () => {
    const status = $('viewerStatus');
    if (status) {
        status.textContent = 'CONNECTED';
        status.classList.remove('status-offline');
        status.classList.add('status-online');
    }
});

socket.on('disconnect', () => {
    const status = $('viewerStatus');
    if (status) {
        status.textContent = 'OFFLINE';
        status.classList.remove('status-online');
        status.classList.add('status-offline');
    }
});

socket.on('webrtc-offer', async ({ sdp }) => {
    if (pc) {
        try { pc.close(); } catch (e) { }
        pc = null;
    }
    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);

    pc.ontrack = (e) => {
        const v = $('viewerVideo');
        if (v && !v.srcObject) {
            v.srcObject = e.streams[0];
            v.play().catch(() => { });
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { sdp: answer });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// ==========================================
// 3. CHAT & CALL REQUEST LOGIC
// ==========================================

// Separate peer for stage call (host <-> viewer)
let callPc = null;
let localCallStream = null;

// Handle call accept if the host calls the viewer
// A-mode: viewer stays on this page, sends camera/mic up,
// host can then mix them like any other guest call.
socket.on('ring-alert', async ({ from, fromId }) => {
    const ok = confirm(
        `Host ${from} is calling you on stage! Click OK to share your camera and join the mix.`
    );
    if (!ok) return;
    try {
        await startStageCall(fromId);
    } catch (err) {
        console.error('Stage call failed:', err);
        alert('Could not start call – check camera/mic permissions.');
    }
});

async function startStageCall(targetId) {
    // Get media if not already grabbed
    if (!localCallStream) {
        localCallStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        // Optional: if you add <video id="selfCamPreview"> to view.html,
        // you get a little local preview of your own cam.
        const selfVideo = $('selfCamPreview');
        if (selfVideo) {
            selfVideo.srcObject = localCallStream;
            selfVideo.muted = true;
            selfVideo.play().catch(() => { });
        }
    }

    // Close any old call
    if (callPc) {
        try { callPc.close(); } catch (e) { }
        callPc = null;
    }

    callPc = new RTCPeerConnection(iceConfig);

    // ICE → host
    callPc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('call-ice', {
                targetId,
                candidate: e.candidate
            });
        }
    };

    // Optional: if host sends a separate direct cam back, we just log it.
    callPc.ontrack = (e) => {
        console.log('Stage call remote track from host:', e.streams[0]);
    };

    // Attach our cam/mic to the peer connection
    localCallStream.getTracks().forEach(t => callPc.addTrack(t, localCallStream));

    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);

    socket.emit('call-offer', { targetId, offer });
}

// Answer / ICE from host for the stage call
socket.on('call-answer', async ({ from, answer }) => {
    if (!callPc) return;
    try {
        await callPc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
        console.error('Failed to apply stage call answer:', e);
    }
});

socket.on('call-ice', async ({ from, candidate }) => {
    if (!callPc || !candidate) return;
    try {
        await callPc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
        console.error('Failed to add stage ICE candidate:', e);
    }
});

socket.on('call-end', ({ from }) => {
    if (!callPc) return;
    try { callPc.close(); } catch (e) { }
    callPc = null;
});

// === Chat display ===
socket.on('public-chat', d => {
    const log = $('chatLog');
    if (!log) return;

    const div = document.createElement('div');
    div.className = 'chat-line';

    const name = document.createElement('strong');
    name.textContent = d.name + ': ';

    const msg = document.createElement('span');
    msg.textContent = d.text;

    div.appendChild(name);
    div.appendChild(msg);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
});

socket.on('kicked', () => {
    alert("You have been kicked from the room by the host.");
    window.location.href = "index.html";
});

socket.on('room-error', (err) => {
    alert(err);
    window.location.href = "index.html";
});

// ==========================================
// 4. VIEWER UI WIRING
// ==========================================
window.addEventListener('load', () => {
    const url = new URL(window.location.href);
    const room = url.searchParams.get('room') || 'lobby';
    const name = url.searchParams.get('name');

    if (name) myName = name;

    const nameLabel = $('viewerNameLabel');
    if (nameLabel) nameLabel.textContent = myName;

    joinAsViewer(room);

    if ($('requestCallBtn')) {
        $('requestCallBtn').onclick = () => {
            socket.emit('request-to-call');
            $('requestCallBtn').textContent = "Request Sent ✋";
            $('requestCallBtn').disabled = true;
        };
    }

    if ($('unmuteBtn')) {
        $('unmuteBtn').onclick = () => {
            const v = $('viewerVideo');
            if (!v) return;
            v.muted = !v.muted;
            $('unmuteBtn').textContent = v.muted ? '🔇 Unmute' : '🔊 Mute';
        };
    }

    if ($('fullscreenBtn')) {
        $('fullscreenBtn').onclick = () => {
            const v = $('viewerVideo');
            if (v.requestFullscreen) v.requestFullscreen();
            else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
            else if (v.msRequestFullscreen) v.msRequestFullscreen();
        };
    }

    if ($('toggleChatBtn')) {
        $('toggleChatBtn').onclick = () => {
            const box = $('chatBox');
            if (box) box.classList.toggle('hidden');
        };
    }

    if ($('chatInput') && $('chatSendBtn')) {
        $('chatSendBtn').onclick = () => sendChat();
        $('chatInput').onkeydown = (e) => {
            if (e.key === 'Enter') sendChat();
        };
    }
});

// Viewer chat send (to be relayed as fromViewer)
function sendChat() {
    const input = $('chatInput');
    if (!input || !currentRoom) return;
    const text = input.value.trim();
    if (!text) return;

    socket.emit('public-chat', {
        room: currentRoom,
        name: myName,
        text,
        fromViewer: true
    });

    input.value = '';
}
