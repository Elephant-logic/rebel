const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random()*1000);

// ==========================================
// ARCADE RECEIVER (Game -> Chat Logic)
// ==========================================
function setupReceiver(pc) {
    pc.ondatachannel = (e) => {
        if(e.channel.label !== "side-load-pipe") return; 
        const chan = e.channel;
        let chunks = [], total = 0, curr = 0, meta = null;
        chan.onmessage = (evt) => {
            if(typeof evt.data === 'string') {
                try { meta = JSON.parse(evt.data); total = meta.size; } catch(e){}
            } else {
                chunks.push(evt.data); curr += evt.data.byteLength;
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
    const div = document.createElement('div');
    div.className = 'chat-line system-msg';
    div.innerHTML = `<div style="background:rgba(74,243,163,0.1);border:1px solid #4af3a3;padding:10px;border-radius:8px;text-align:center;">
        <div style="color:#4af3a3;font-weight:bold;">🚀 TOOL RECEIVED: ${name}</div>
        <a href="${url}" download="${name}" style="background:#4af3a3;color:#000;padding:6px;border-radius:4px;display:inline-block;margin-top:5px;text-decoration:none;font-weight:bold;">LAUNCH NOW</a>
    </div>`;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
}

const params = new URLSearchParams(location.search);
const room = params.get('room');
if(room) { 
    currentRoom = room; 
    myName = prompt("Name?") || myName;
    socket.connect(); 
    socket.emit('join-room', {room, name:myName}); 
}

// PATCH: Viewer will only receive stream if Host has clicked "Start Stream"
socket.on('webrtc-offer', async ({sdp, from}) => {
    // Kill old connection to ensure clean stream handover if host changes
    if(pc) pc.close();
    
    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);
    
    pc.ontrack = e => { 
        if($('viewerVideo').srcObject !== e.streams[0]) {
            $('viewerVideo').srcObject = e.streams[0];
            if($('viewerStatus')) $('viewerStatus').textContent = "LIVE";
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

socket.on('public-chat', d => { 
    const div = document.createElement('div'); 
    div.className = 'chat-line';
    // Anti-XSS Secure Rendering
    const name = document.createElement('strong'); name.textContent = d.name;
    const msg = document.createElement('span'); msg.textContent = `: ${d.text}`;
    div.appendChild(name);
    div.appendChild(msg);
    $('chatLog').appendChild(div); 
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
});

// PATCH: Handling kicks and room locking for viewers
socket.on('kicked', () => {
    alert("You have been removed from the room.");
    window.location.href = "index.html";
});

socket.on('room-error', (err) => {
    alert(err);
    window.location.href = "index.html";
});

$('sendBtn').onclick = () => { 
    if(!$('chatInput').value.trim()) return;
    socket.emit('public-chat', {room:currentRoom, text:$('chatInput').value, name:myName, fromViewer:true}); 
    $('chatInput').value=''; 
};

// UI Helpers for Viewer Page
if($('unmuteBtn')) {
    $('unmuteBtn').onclick = () => {
        $('viewerVideo').muted = !$('viewerVideo').muted;
        $('unmuteBtn').textContent = $('viewerVideo').muted ? "🔇 Unmute" : "🔊 Muted";
    };
}

if($('fullscreenBtn')) {
    $('fullscreenBtn').onclick = () => {
        if ($('viewerVideo').requestFullscreen) $('viewerVideo').requestFullscreen();
    };
}
