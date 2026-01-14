const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random()*1000);

// --- ARCADE RECEIVER ---
function setupReceiver(pc) {
    pc.ondatachannel = (e) => {
        const chan = e.channel;
        if(chan.label !== "side-load-pipe") return; 

        let chunks = [];
        let total = 0, curr = 0, meta = null;

        chan.onmessage = (evt) => {
            const d = evt.data;
            if(typeof d === 'string') {
                try { meta = JSON.parse(d); total = meta.size; $('viewerStatus').textContent = "INCOMING: " + meta.name; } catch(e){}
            } else {
                chunks.push(d); curr += d.byteLength;
                if(total > 0) $('viewerStatus').textContent = `DL: ${Math.round((curr/total)*100)}%`;
                
                if(curr >= total) {
                    const blob = new Blob(chunks, {type: meta?meta.mime:'application/octet-stream'});
                    const url = URL.createObjectURL(blob);
                    showLaunchButton(url, meta?meta.name:'Game');
                    chan.close();
                    $('viewerStatus').textContent = "LIVE";
                }
            }
        };
    };
}

function showLaunchButton(url, name) {
    const old = $('arcadeBtn'); if(old) old.remove();
    
    const btn = document.createElement('a');
    btn.id = 'arcadeBtn';
    btn.href = url;
    btn.download = name;
    btn.innerHTML = `🕹️ LAUNCH: ${name}`;
    
    // Aggressive Styling
    Object.assign(btn.style, {
        display: 'block', padding: '15px 30px', background: '#4af3a3', 
        color: '#000', fontWeight: '900', textDecoration: 'none',
        borderRadius: '8px', border: '3px solid #fff',
        boxShadow: '0 0 30px #4af3a3', fontSize: '1.2rem',
        cursor: 'pointer', transform: 'scale(0)', transition: 'transform 0.3s',
        pointerEvents: 'auto' // Ensure clickable
    });
    
    // *** FIX: REMOVE BUTTON WHEN CLICKED ***
    btn.onclick = () => {
        btn.style.transform = 'scale(0)';
        setTimeout(() => btn.remove(), 300); // Remove after animation
    };
    
    const container = $('toolboxContainer') || document.body;
    container.appendChild(btn);
    setTimeout(() => btn.style.transform = 'scale(1)', 50);
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

// --- WEBRTC ---
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

// --- CHAT & UI ---
const log = $('chatLog');
function addChat(n,t) { const d=document.createElement('div'); d.className='chat-line'; d.innerHTML=`<strong>${n}</strong>: ${t}`; log.appendChild(d); log.scrollTop=log.scrollHeight; }
socket.on('public-chat', d => addChat(d.name, d.text));

const send = () => { const i=$('chatInput'); if(!i.value.trim()) return; socket.emit('public-chat', {room:currentRoom, text:i.value, name:myName, fromViewer:true}); i.value=''; };
$('sendBtn').onclick = send; $('chatInput').onkeydown = e => { if(e.key==='Enter') send(); };

// --- EMOJI LISTENER ---
const emojiStrip = $('emojiStrip');
if(emojiStrip) {
    emojiStrip.onclick = (e) => {
        if(e.target.classList.contains('emoji')) {
            const input = $('chatInput');
            input.value += e.target.textContent;
            input.focus();
        }
    };
}

$('toggleChatBtn').onclick = () => $('chatBox').classList.toggle('hidden');
$('fullscreenBtn').onclick = () => document.documentElement.requestFullscreen().catch(()=>{});
$('unmuteBtn').onclick = () => { const v = $('viewerVideo'); v.muted = !v.muted; $('unmuteBtn').textContent = v.muted ? '🔇 Unmute' : '🔊 Mute'; };
