const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random()*1000);

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
                    addGameToChat(URL.createObjectURL(blob), meta?meta.name:'Tool');
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
    div.innerHTML = `<div style="border:1px solid #4af3a3; padding:10px; border-radius:8px; margin: 10px 0;">
        <div style="color:#4af3a3; font-weight:bold;">🚀 TOOL RECEIVED: ${name}</div>
        <a href="${url}" download="${name}" style="background:#4af3a3; color:#000; padding:4px 8px; border-radius:4px; text-decoration:none; font-weight:bold; font-size:0.8rem;">DOWNLOAD</a>
    </div>`;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
}

const params = new URLSearchParams(location.search);
const room = params.get('room');
if(room) { 
    currentRoom = room; 
    myName = prompt("Enter display name:") || myName;
    socket.connect(); 
    socket.emit('join-room', {room, name:myName, isViewer: true}); // Identify as viewer
}

socket.on('webrtc-offer', async ({sdp, from}) => {
    if(pc) pc.close();
    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);
    pc.ontrack = e => { 
        $('viewerVideo').srcObject = e.streams[0];
        $('viewerStatus').textContent = "LIVE";
        $('viewerStatus').style.background = "var(--accent)";
    };
    pc.onicecandidate = e => e.candidate && socket.emit('webrtc-ice-candidate', {targetId:from, candidate:e.candidate});
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('webrtc-answer', {targetId:from, sdp:ans});
});

socket.on('webrtc-ice-candidate', async ({candidate}) => pc && await pc.addIceCandidate(new RTCIceCandidate(candidate)));

// GUEST TRANSITION LOGIC
socket.on('ring-alert', async ({ from }) => {
    if (confirm(`${from} is bringing you on stage. Enable your camera?`)) {
       joinAsGuest();
    }
});

function joinAsGuest() {
    const mainAppUrl = new URL(window.location.href);
    mainAppUrl.pathname = mainAppUrl.pathname.replace('view.html', 'index.html');
    mainAppUrl.searchParams.set('room', currentRoom);
    mainAppUrl.searchParams.set('name', myName);
    window.location.href = mainAppUrl.toString();
}

if($('requestCallBtn')) {
    $('requestCallBtn').onclick = () => {
        socket.emit('request-to-call');
        $('requestCallBtn').textContent = "Request Sent ✋";
        $('requestCallBtn').disabled = true;
    };
}

socket.on('public-chat', d => { 
    const div = document.createElement('div'); 
    div.className = 'chat-line';
    div.innerHTML = `<strong>${d.name}</strong>: ${d.text}`;
    $('chatLog').appendChild(div); 
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
});

$('sendBtn').onclick = () => { 
    const inp = $('chatInput');
    if(!inp.value.trim()) return;
    socket.emit('public-chat', {room:currentRoom, text:inp.value}); 
    inp.value=''; 
};
