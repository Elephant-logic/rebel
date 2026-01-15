const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random()*1000);

// ==========================================
// ARCADE RECEIVER (P2P Binary Transfer)
// ==========================================
function setupReceiver(pc) {
    pc.ondatachannel = (e) => {
        const chan = e.channel;
        if(chan.label !== "side-load-pipe") return; 

        let chunks = [];
        let total = 0, curr = 0, meta = null;
        // Unique ID for this specific transfer's progress bar in chat
        let progId = "prog-" + Math.floor(Math.random()*1000);

        chan.onmessage = (evt) => {
            const d = evt.data;
            if(typeof d === 'string') {
                try { 
                    meta = JSON.parse(d); 
                    total = meta.size; 
                    // Create the progress UI in the chat log immediately
                    createProgressUI(progId, meta.name);
                } catch(e){}
            } else {
                chunks.push(d); curr += d.byteLength;
                
                // Update the specific progress bar in the chat
                const bar = document.getElementById(progId);
                if(bar && total > 0) {
                    bar.style.width = Math.round((curr/total)*100) + "%";
                }
                
                if(curr >= total) {
                    const blob = new Blob(chunks, {type: meta?meta.mime:'application/octet-stream'});
                    const url = URL.createObjectURL(blob);
                    
                    // Replace the progress bar with the Launch Button Card
                    const container = document.getElementById('container-' + progId);
                    if(container) {
                        container.innerHTML = `
                            <div style="background: rgba(74, 243, 163, 0.1); border: 1px solid #4af3a3; padding: 10px; border-radius: 8px; text-align: center;">
                                <div style="color: #4af3a3; font-weight: 900; font-size: 0.9rem; margin-bottom: 5px;">🚀 TOOL READY</div>
                                <div style="font-size: 0.8rem; margin-bottom: 8px; color: #fff;">${meta.name}</div>
                                <a href="${url}" download="${meta.name}" style="background: #4af3a3; color: #000; padding: 6px 12px; text-decoration: none; font-weight: bold; border-radius: 4px; display: inline-block;">
                                    ▶️ LAUNCH NOW
                                </a>
                            </div>
                        `;
                    }
                    chan.close();
                }
            }
        };
    };
}

function createProgressUI(id, name) {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.id = 'container-' + id;
    div.className = 'chat-line system-msg';
    div.innerHTML = `
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; border: 1px solid #444; margin: 10px 0;">
            <div style="font-size:0.7rem; color:#aaa; margin-bottom:5px;">📥 DOWNLOADING: ${name}</div>
            <div style="width:100%; height:6px; background:#000; border-radius:3px; overflow:hidden;">
                <div id="${id}" style="width:0%; height:100%; background:#4af3a3; transition:width 0.2s;"></div>
            </div>
        </div>
    `;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

// --- INIT ---
const params = new URLSearchParams(location.search);
const room = params.get('room');
if(room) { 
    currentRoom = room; 
    const n = prompt("Name?") || myName;
    myName = n;
    socket.connect(); 
    socket.emit('join-room', {room, name:myName}); 
} else { alert("No Room ID"); }

socket.on('disconnect', () => $('viewerStatus').textContent="Disconnected");

// --- WEBRTC OFFER HANDLING ---
socket.on('webrtc-offer', async ({sdp, from}) => {
    if(pc) pc.close();
    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);
    
    pc.ontrack = e => {
        const v = $('viewerVideo');
        if(v.srcObject !== e.streams[0]) {
            v.srcObject = e.streams[0];
            v.play().catch(e=>console.log(e));
            $('viewerStatus').textContent = "LIVE";
        }
    };
    pc.onicecandidate = e => { if(e.candidate) socket.emit('webrtc-ice-candidate', {targetId:from, candidate:e.candidate}); };
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('webrtc-answer', {targetId:from, sdp:ans});
});
socket.on('webrtc-ice-candidate', async ({candidate}) => { if(pc) await pc.addIceCandidate(new RTCIceCandidate(candidate)); });

// --- ROOM UPDATE (Viewer Count) ---
socket.on('room-update', ({ viewerCount }) => {
    if ($('viewerStatusMirror')) {
        $('viewerStatusMirror').textContent = `👀 ${viewerCount || 0} Watching`;
    }
});

// --- CHAT LOGIC ---
const log = $('chatLog');
function addChat(n,t) { 
    const d=document.createElement('div'); 
    d.className='chat-line'; 
    d.innerHTML=`<strong style="color:#4af3a3">${n}</strong>: <span style="color:#ddd">${t}</span>`; 
    log.appendChild(d); 
    log.scrollTop=log.scrollHeight; 
}
socket.on('public-chat', d => addChat(d.name, d.text));

const send = () => { 
    const i=$('chatInput'); 
    if(!i.value.trim()) return; 
    socket.emit('public-chat', {room:currentRoom, text:i.value, name:myName, fromViewer:true}); 
    i.value=''; 
};
$('sendBtn').onclick = send; 
$('chatInput').onkeydown = e => { if(e.key==='Enter') send(); };

// Emojis
if ($('emojiStrip')) $('emojiStrip').onclick = (e) => { 
    if (e.target.classList.contains('emoji')) {
        $('chatInput').value += e.target.textContent;
        $('chatInput').focus();
    }
};

$('toggleChatBtn').onclick = () => $('chatBox').classList.toggle('hidden');
$('fullscreenBtn').onclick = () => document.documentElement.requestFullscreen().catch(()=>{});
$('unmuteBtn').onclick = () => { 
    const v = $('viewerVideo'); 
    v.muted = !v.muted; 
    $('unmuteBtn').textContent = v.muted ? '🔇 Unmute' : '🔊 Mute'; 
};
