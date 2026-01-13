// ==========================================
// ARCADE RECEIVER (Secured)
// ==========================================
function setupReceiver(pc, onComplete, onProgress) {
    pc.ondatachannel = (e) => {
        if (e.channel.label !== "side-load-pipe") return;
        const channel = e.channel;
        let receivedChunks = [];
        let totalSize = 0;
        let currentSize = 0;
        let meta = null;

        channel.onmessage = (event) => {
            const data = event.data;
            if (typeof data === 'string') {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'meta') { meta = parsed; totalSize = meta.size; return; }
                } catch(e) {}
            }
            if (data instanceof ArrayBuffer) {
                receivedChunks.push(data);
                currentSize += data.byteLength;
                if (onProgress && totalSize > 0) onProgress(Math.min(100, Math.round((currentSize / totalSize) * 100)));
                
                if (currentSize >= totalSize) {
                    const blob = new Blob(receivedChunks, { type: meta ? meta.mime : 'application/octet-stream' });
                    // FIX: Sanitize Filename
                    const safeName = meta ? meta.name.replace(/[^a-zA-Z0-9._-]/g, '_') : 'download.bin';
                    if (onComplete) onComplete({ blob, name: safeName });
                    channel.close();
                }
            }
        };
    };
}

const $ = id => document.getElementById(id);

if (typeof io === 'undefined') { alert("Critical Error: Socket.io did not load."); throw new Error("Socket.io missing"); }

const socket = io({ autoConnect: false });
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;
let currentRoom = null;
let myName = "";

function pickName() {
  const input = prompt("Enter your name for the chat:") || "";
  const clean = input.trim().slice(0, 20); 
  return clean ? clean : `Viewer-${Math.floor(Math.random() * 1000)}`;
}

function init() {
    const params = new URLSearchParams(window.location.search);
    let room = params.get('room');
    if (!room) room = prompt("Enter the Room ID to join:");

    if (room) {
        currentRoom = room;
        $('viewerStatus').textContent = 'Connecting...';
        myName = pickName();
        socket.connect();
        socket.emit('join-room', { room, name: myName });
    } else {
        $('viewerStatus').textContent = 'No Room ID';
        alert("You must have a Room ID to join a stream.");
    }
}
init();

socket.on('disconnect', () => $('viewerStatus').textContent = 'Disconnected');

// --- WEBRTC LOGIC ---
socket.on('webrtc-offer', async ({ sdp, from }) => {
    if (pc) pc.close();
    pc = new RTCPeerConnection(iceConfig);
    
    // ARCADE HOOK
    setupReceiver(pc, 
        ({ blob, name }) => {
            const url = URL.createObjectURL(blob);
            const oldBtn = document.getElementById('arcadeBtn');
            if(oldBtn) oldBtn.remove();

            // FIX: Secure Button Creation
            const btn = document.createElement('a');
            btn.id = 'arcadeBtn';
            btn.href = url;
            btn.download = name;
            btn.className = 'btn primary';
            
            const icon = document.createElement('div');
            icon.textContent = "🕹️ LAUNCH TOOL";
            icon.style.fontWeight = "bold";
            const sub = document.createElement('div');
            sub.textContent = name;
            sub.style.fontSize = "0.7rem";
            
            btn.appendChild(icon);
            btn.appendChild(sub);
            
            Object.assign(btn.style, {
                position: 'absolute', top: '20px', right: '20px',
                zIndex: '2000', boxShadow: '0 5px 20px rgba(0,0,0,0.8)',
                textAlign: 'center', padding: '10px 20px', border: '2px solid #4af3a3',
                textDecoration: 'none', color: '#000'
            });
            
            const container = document.querySelector('.video-container');
            if(container) container.appendChild(btn);
            $('viewerStatus').textContent = 'LIVE'; 
        },
        (percent) => { $('viewerStatus').textContent = `Loading Toolbox: ${percent}%`; }
    );

    pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId: from, candidate: e.candidate }); };
    
    pc.ontrack = e => {
        const vid = $('viewerVideo');
        if (vid.srcObject !== e.streams[0]) {
            vid.srcObject = e.streams[0];
            vid.play().catch(err => console.log("Autoplay blocked"));
            $('viewerStatus').textContent = 'LIVE';
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { targetId: from, sdp: answer });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => { if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate)); });

// --- CHAT LOGIC ---
socket.on('public-chat', ({ name, text, ts }) => {
    const log = $('chatLog');
    const d = document.createElement('div');
    d.className = 'chat-line';
    const strong = document.createElement('strong');
    strong.textContent = name;
    const msgText = document.createTextNode(`: ${text}`);
    d.append(strong, msgText);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
});

function sendChat() {
    const inp = $('chatInput');
    const text = inp.value.trim();
    if (!text) return;
    socket.emit('public-chat', { room: currentRoom, text, fromViewer: true, name: myName });
    inp.value = '';
}

$('sendBtn').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

if ($('emojiStrip')) $('emojiStrip').addEventListener('click', (e) => { if (e.target.classList.contains('emoji')) $('chatInput').value += e.target.textContent; });

$('fullscreenBtn').addEventListener('click', () => document.body.classList.toggle('fullscreen-mode'));

$('toggleChatBtn').addEventListener('click', () => {
    const section = document.querySelector('.chat-section');
    const isHidden = section.style.display === 'none';
    section.style.display = isHidden ? 'flex' : 'none';
    $('toggleChatBtn').textContent = isHidden ? 'Hide Chat' : 'Show Chat';
});

$('unmuteBtn').addEventListener('click', () => {
    const v = $('viewerVideo');
    v.muted = !v.muted;
    $('unmuteBtn').textContent = v.muted ? '🔇 Unmute' : '🔊 Mute';
});
