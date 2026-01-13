const socket = io({ autoConnect: false });
let pc = null;
let currentRoom = null;

const $ = id => document.getElementById(id);
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- HELPER: ASK FOR NAME ---
function pickName() {
  const input = prompt("Enter your name for the chat:") || "";
  const clean = input.trim();
  return clean ? clean : `Viewer-${Math.floor(Math.random() * 1000)}`;
}

let myName = "";

// --- CONNECTION ---
const params = new URLSearchParams(window.location.search);
const room = params.get('room');

if (room) {
    currentRoom = room;
    $('viewerStatus').textContent = 'Connecting...';
    
    // Ask for Name
    myName = pickName();
    
    // Connect
    socket.connect();
    socket.emit('join-room', { room, name: myName });
} else {
    $('viewerStatus').textContent = 'No Room ID';
}

socket.on('disconnect', () => $('viewerStatus').textContent = 'Disconnected');

// --- WEBRTC ---
socket.on('webrtc-offer', async ({ sdp, from }) => {
    if (pc) pc.close();
    pc = new RTCPeerConnection(iceConfig);
    
    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('webrtc-ice-candidate', { targetId: from, candidate: e.candidate });
    };
    pc.ontrack = e => {
        const vid = $('viewerVideo');
        if (vid.srcObject !== e.streams[0]) {
            vid.srcObject = e.streams[0];
            $('viewerStatus').textContent = 'LIVE';
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    // Respond to host
    socket.emit('webrtc-answer', { targetId: from, sdp: answer });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// --- CHAT ---
socket.on('public-chat', ({ name, text, ts }) => {
    const log = $('chatLog');
    const d = document.createElement('div');
    d.className = 'chat-line';
    d.innerHTML = `<strong>${name}</strong>: ${text}`;
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
$('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});

// --- EMOJI FIX (FOR VIEWER) ---
const emojiStrip = $('emojiStrip');
if (emojiStrip) {
    emojiStrip.addEventListener('click', (e) => {
        if (e.target.classList.contains('emoji')) {
            const inp = $('chatInput');
            inp.value += e.target.textContent;
            inp.focus();
        }
    });
}

// --- FULLSCREEN & CONTROLS ---
$('fullscreenBtn').addEventListener('click', () => {
    document.body.classList.toggle('fullscreen-mode');
});

$('toggleChatBtn').addEventListener('click', () => {
    const section = document.querySelector('.chat-section');
    const isHidden = section.style.display === 'none';
    
    if (document.body.classList.contains('fullscreen-mode')) {
        const currentStyle = getComputedStyle(section).display;
        section.style.display = (currentStyle === 'none') ? 'flex' : 'none';
    } else {
        section.style.display = isHidden ? 'flex' : 'none';
    }
    $('toggleChatBtn').textContent = section.style.display === 'none' ? 'Show Chat' : 'Hide Chat';
});

$('unmuteBtn').addEventListener('click', () => {
    const v = $('viewerVideo');
    v.muted = !v.muted;
    $('unmuteBtn').textContent = v.muted ? '🔇 Unmute' : '🔊 Mute';
});
