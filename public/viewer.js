const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random()*1000);

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
    myName = prompt("Enter your display name:") || myName;
    socket.connect(); 
    // Join specifically as a viewer
    socket.emit('join-room', {room, name:myName, isViewer: true}); 
}

socket.on('webrtc-offer', async ({sdp, from}) => {
    if(pc) pc.close();
    
    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);
    
    pc.ontrack = e => { 
        if($('viewerVideo').srcObject !== e.streams[0]) {
            $('viewerVideo').srcObject = e.streams[0];
            if($('viewerStatus')) {
                $('viewerStatus').textContent = "LIVE";
                $('viewerStatus').style.background = "var(--accent)";
            }
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

// ==========================================
// 3. CHAT & UI LOGIC
// ==========================================

// Handle call accept if the host calls the viewer
socket.on('ring-alert', async ({ from }) => {
    if (confirm(`Host ${from} is calling you on stage. Please join the Room via the Main App to enable your camera.`)) {
       // Optional: Redirect to index.html with auto-fill
    }
});

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

// Hand Raise Button
if($('requestCallBtn')) {
    $('requestCallBtn').onclick = () => {
        socket.emit('request-to-call');
        $('requestCallBtn').textContent = "Request Sent ✋";
        $('requestCallBtn').disabled = true;
    };
}

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
        $('unmuteBtn').textContent = v.muted ? "🔇 Unmute" : "🔊 Muted";
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

if($('toggleChatBtn')) {
    $('toggleChatBtn').onclick = () => {
        const box = $('chatBox');
        box.classList.toggle('hidden');
    };
}
