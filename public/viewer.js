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
    
    // ARCADE HOOK (FIXED VISIBILITY)
    setupReceiver(pc, 
        ({ blob, name }) => {
            const url = URL.createObjectURL(blob);
            
            // Remove old button if exists
            const oldBtn = document.getElementById('arcadeBtn');
            if(oldBtn) oldBtn.remove();

            // Create New Button
            const btn = document.createElement('a');
            btn.id = 'arcadeBtn';
            btn.href = url;
            btn.download = name;
            btn.className = 'btn primary';
            btn.style.cssText = `
                display: block; text-align: center; 
                padding: 12px 20px; box-shadow: 0 0 15px #4af3a3; 
                text-decoration: none; color: #000; font-weight: 800; border: 2px solid #fff;
                animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            `;
            btn.innerHTML = `<div>🕹️ LAUNCH TOOL</div><div style="font-size:0.7rem">${name}</div>`;
            
            const style = document.createElement('style');
            style.innerHTML = `@keyframes popIn { from { transform: scale(0); } to { transform: scale(1); } }`;
            document.head.appendChild(style);

            // APPEND TO NEW CONTAINER
            const container = document.getElementById('toolboxContainer') || document.body;
            container.appendChild(btn);
            
            $('viewerStatus').textContent = 'TOOL RECEIVED'; 
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
    const d = document.createElement('div'); d.className = 'chat-line';
    const s = document.createElement('strong'); s.textContent = name;
    const txt = document.createTextNode(`: ${text}`);
    d.append(s, txt);
    log.appendChild(d); log.scrollTop = log.scrollHeight;
});
function sendChat() {
    const inp = $('chatInput'); const text = inp.value.trim();
    if (!text) return;
    socket.emit('public-chat', { room: currentRoom, text, fromViewer: true, name: myName });
    inp.value = '';
}
$('sendBtn').onclick = sendChat;
$('chatInput').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
if ($('emojiStrip')) $('emojiStrip').onclick = (e) => { if (e.target.classList.contains('emoji')) $('chatInput').value += e.target.textContent; };

$('fullscreenBtn').onclick = () => document.body.classList.toggle('fullscreen-mode');
$('toggleChatBtn').onclick = () => {
    const section = document.querySelector('.chat-section');
    const isHidden = section.style.display === 'none';
    section.style.display = isHidden ? 'flex' : 'none';
    $('toggleChatBtn').textContent = isHidden ? 'Hide Chat' : 'Show Chat';
};
$('unmuteBtn').onclick = () => {
    const v = $('viewerVideo');
    v.muted = !v.muted;
    $('unmuteBtn').textContent = v.muted ? '🔇 Unmute' : '🔊 Mute';
};
