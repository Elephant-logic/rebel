const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random()*1000);
let streamLive = false;
let requestPending = false;
let roomLocked = false;

function setViewerStatus(live) {
    streamLive = !!live;
    const status = $('viewerStatus');
    if (status) {
        status.textContent = live ? "LIVE" : "OFFLINE";
        status.style.background = live ? "var(--accent)" : "var(--danger)";
    }
    const mirror = $('viewerStatusMirror');
    if (mirror) {
        mirror.textContent = live ? "LIVE" : "OFFLINE";
    }
}

setViewerStatus(false);
updateRequestButton();

function updateRequestButton() {
    const btn = $('requestCallBtn');
    if (!btn) return;
    if (roomLocked) {
        btn.textContent = "🔒 Room Locked";
        btn.disabled = true;
        return;
    }
    if (requestPending) {
        btn.textContent = "Request Sent ✋";
        btn.disabled = true;
        return;
    }
    btn.textContent = "✋ Request to Join";
    btn.disabled = false;
}

// ==========================================
// 1. ARCADE RECEIVER (Game -> Chat Logic)
// ==========================================
function setupReceiver(pc) {
    pc.ondatachannel = (e) => {
        if(e.channel.label !== "side-load-pipe") return; 
        const chan = e.channel;
        let chunks = [], total = 0, curr = 0, meta = null;

        chan.onmessage = (evt) => {
            if(typeof evt.data === 'string') {
                try { 
                    meta = JSON.parse(evt.data); 
                    total = meta.size; 
                    console.log(`[Arcade] Receiving: ${meta.name}`);
                } catch(e){}
            } else {
                chunks.push(evt.data); 
                curr += evt.data.byteLength;
                
                if(curr >= total) {
                    const blob = new Blob(chunks, {type: meta?meta.mime:'application/octet-stream'});
                    const url = URL.createObjectURL(blob);
                    addGameToChat(url, meta?meta.name:'Tool');
                    chan.close();
                }
            }
        };
    };
}

function addGameToChat(url, name) {
    const log = $('chatLog');
    if(!log) return;
    const div = document.createElement('div');
    div.className = 'chat-line system-msg';
    div.innerHTML = `
        <div style="background:rgba(74,243,163,0.1); border:1px solid #4af3a3; padding:10px; border-radius:8px; text-align:center; margin: 10px 0;">
            <div style="color:#4af3a3; font-weight:bold; margin-bottom:5px;">🚀 TOOL RECEIVED: ${name}</div>
            <a href="${url}" download="${name}" style="background:#4af3a3; color:#000; padding:6px 12px; border-radius:4px; display:inline-block; text-decoration:none; font-weight:bold; font-size:0.8rem;">LAUNCH NOW</a>
        </div>`;
    log.appendChild(div); 
    log.scrollTop = log.scrollHeight;
}

// ==========================================
// 2. ROOM & CONNECTION LOGIC
// ==========================================
const params = new URLSearchParams(location.search);
const room = params.get('room');
if(room) { 
    currentRoom = room; 
    const nameParam = params.get('name');
    myName = nameParam || prompt("Enter your display name:") || myName;
    socket.connect(); 
}

socket.on('connect', () => {
    if (!currentRoom) return;
    socket.emit('join-room', { room: currentRoom, name: myName, isViewer: true }); 
});

socket.on('disconnect', () => {
    setViewerStatus(false);
    requestPending = false;
    updateRequestButton();
    if (pc) {
        pc.close();
        pc = null;
    }
});

socket.on('webrtc-offer', async ({sdp, from}) => {
    if(pc) pc.close();
    
    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);
    
    pc.ontrack = e => { 
        if($('viewerVideo').srcObject !== e.streams[0]) {
            $('viewerVideo').srcObject = e.streams[0];
            $('viewerVideo').muted = true;
            setViewerStatus(true);
            $('viewerVideo').play().catch(() => {});
        }
    };

    pc.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
            setViewerStatus(false);
        }
    };
    
    pc.onicecandidate = e => { 
        if(e.candidate) socket.emit('webrtc-ice-candidate', {targetId:from, candidate:e.candidate}); 
    };
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('webrtc-answer', {targetId:from, sdp:ans});
});

socket.on('webrtc-ice-candidate', async ({candidate}) => { 
    if(pc) await pc.addIceCandidate(new RTCIceCandidate(candidate)); 
});

socket.on('stream-status', ({ live }) => {
    setViewerStatus(!!live);
    if (!live) {
        const video = $('viewerVideo');
        if (video) video.srcObject = null;
        if (pc) {
            pc.close();
            pc = null;
        }
    } else {
        const video = $('viewerVideo');
        if (video) video.play().catch(() => {});
    }
});

socket.on('room-update', ({ locked }) => {
    roomLocked = !!locked;
    updateRequestButton();
});

// ==========================================
// 3. CHAT & UI LOGIC
// ==========================================

// Handle call accept if the host calls the viewer
socket.on('ring-alert', async ({ from }) => {
    if (confirm(`Host ${from} is calling you on stage! Click OK to switch to Guest Mode and enable your camera.`)) {
       joinAsGuest();
    }
});

function joinAsGuest() {
    const mainAppUrl = new URL(window.location.href);
    mainAppUrl.pathname = mainAppUrl.pathname.replace('view.html', 'index.html');
    mainAppUrl.searchParams.set('room', currentRoom);
    mainAppUrl.searchParams.set('name', myName);
    mainAppUrl.searchParams.set('autojoin', '1');
    window.location.href = mainAppUrl.toString();
}

socket.on('public-chat', d => { 
    const log = $('chatLog');
    if(!log) return;
    
    const div = document.createElement('div'); 
    div.className = 'chat-line';
    
    const name = document.createElement('strong');
    name.textContent = d.name;
    const msg = document.createElement('span');
    msg.textContent = `: ${d.text}`;
    
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

// Chat Input
$('sendBtn').onclick = () => { 
    const inp = $('chatInput');
    if(!inp || !inp.value.trim()) return;
    socket.emit('public-chat', {room:currentRoom, text:inp.value, name:myName, fromViewer:true}); 
    inp.value=''; 
};

if($('chatInput')) {
    $('chatInput').onkeydown = (e) => {
        if(e.key === 'Enter') $('sendBtn').onclick();
    };
}

// Hand Raise Button logic
if($('requestCallBtn')) {
    $('requestCallBtn').onclick = () => {
        if (roomLocked) {
            updateRequestButton();
            return;
        }
        socket.emit('request-to-call');
        requestPending = true;
        updateRequestButton();
    };
}

socket.on('call-request-response', ({ approved, reason }) => {
    const btn = $('requestCallBtn');
    if (!btn) return;
    if (approved) {
        btn.textContent = "Approved ✅ Joining...";
        btn.disabled = true;
        requestPending = false;
        setTimeout(() => joinAsGuest(), 800);
    } else {
        requestPending = false;
        if (reason === 'locked') {
            roomLocked = true;
        }
        updateRequestButton();
    }
});

if($('emojiStrip')) {
    $('emojiStrip').onclick = (e) => {
        if(e.target.classList.contains('emoji')) {
            $('chatInput').value += e.target.textContent;
        }
    };
}

// UI Controls
if($('unmuteBtn')) {
    $('unmuteBtn').onclick = () => {
        const v = $('viewerVideo');
        v.muted = !v.muted;
        $('unmuteBtn').textContent = v.muted ? "🔇 Unmute" : "🔊 Mute";
    };
}

if($('fullscreenBtn')) {
    $('fullscreenBtn').onclick = () => {
        const v = $('viewerVideo');
        if (v.requestFullscreen) v.requestFullscreen();
        else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
        else if (v.msRequestFullscreen) v.msRequestFullscreen();
    };
}

const viewerVideo = $('viewerVideo'); //
if (viewerVideo) {
    viewerVideo.onclick = () => {
        viewerVideo.play().catch(() => {});
    };
}

if($('toggleChatBtn')) {
    $('toggleChatBtn').onclick = () => {
        const box = $('chatBox');
        box.classList.toggle('hidden');
    };
}
