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
        const chan = e.channel;
        if(chan.label !== "side-load-pipe") return; 

        let chunks = [];
        let total = 0, curr = 0, meta = null;

        chan.onmessage = (evt) => {
            const d = evt.data;
            if(typeof d === 'string') {
                try { 
                    meta = JSON.parse(d); 
                    total = meta.size; 
                    $('viewerStatus').textContent = "INCOMING: " + meta.name; 
                } catch(e){}
            } else {
                chunks.push(d); curr += d.byteLength;
                
                // Show percentage in status bar
                if(total > 0) $('viewerStatus').textContent = `DL: ${Math.round((curr/total)*100)}%`;
                
                if(curr >= total) {
                    const blob = new Blob(chunks, {type: meta?meta.mime:'application/octet-stream'});
                    const url = URL.createObjectURL(blob);
                    
                    addGameToChat(url, meta?meta.name:'Game');
                    
                    chan.close();
                    $('viewerStatus').textContent = "LIVE";
                }
            }
        };
    };
}

function addGameToChat(url, name) {
    const log = $('chatLog');
    
    // Force open chat so they see it
    const chatBox = $('chatBox');
    if(chatBox.classList.contains('hidden')) {
        chatBox.classList.remove('hidden');
    }

    const div = document.createElement('div');
    div.className = 'chat-line system-msg';
    
    // Create a nice looking card inside the chat
    div.innerHTML = `
        <div style="background: rgba(74, 243, 163, 0.1); border: 1px solid #4af3a3; padding: 10px; border-radius: 8px; margin: 10px 0; text-align: center;">
            <div style="color: #4af3a3; font-weight: 900; font-size: 0.9rem; margin-bottom: 5px;">🚀 NEW TOOL RECEIVED</div>
            <div style="font-size: 0.8rem; margin-bottom: 8px; color: #fff;">${name}</div>
            <a href="${url}" download="${name}" style="background: #4af3a3; color: #000; padding: 6px 12px; text-decoration: none; font-weight: bold; border-radius: 4px; display: inline-block; cursor: pointer;">
                ▶️ LAUNCH NOW
            </a>
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

socket.on('disconnect', () => {
    $('viewerStatus').textContent="Disconnected";
    if(pc) { pc.close(); pc = null; }
});

// --- WEBRTC ---
socket.on('webrtc-offer', async ({sdp, from}) => {
    // If old host crashed and new host promotes, kill old PC
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

// --- CHAT & UI ---
const log = $('chatLog');
function addChat(n,t) { 
    const d=document.createElement('div'); 
    d.className='chat-line'; 
    d.innerHTML=`<strong style="color:#4af3a3">${n}</strong>: <span style="color:#ddd">${t}</span>`; 
    log.appendChild(d); 
    log.scrollTop=log.scrollHeight; 
}
socket.on('public-chat', d => addChat(d.name, d.text));

const send = () => { const i=$('chatInput'); if(!i.value.trim()) return; socket.emit('public-chat', {room:currentRoom, text:i.value, name:myName, fromViewer:true}); i.value=''; };
$('sendBtn').onclick = send; $('chatInput').onkeydown = e => { if(e.key==='Enter') send(); };

// Emojis
if ($('emojiStrip')) $('emojiStrip').onclick = (e) => { 
    if (e.target.classList.contains('emoji')) {
        $('chatInput').value += e.target.textContent;
        $('chatInput').focus();
    }
};

$('toggleChatBtn').onclick = () => $('chatBox').classList.toggle('hidden');
$('fullscreenBtn').onclick = () => document.documentElement.requestFullscreen().catch(()=>{});
$('unmuteBtn').onclick = () => { const v = $('viewerVideo'); v.muted = !v.muted; $('unmuteBtn').textContent = v.muted ? '🔇 Unmute' : '🔊 Mute'; };
