import { setupReceiver } from './side-loader.js';

const socket = io({ autoConnect: false });
let pc = null;
let currentRoom = null;

const $ = id => document.getElementById(id);
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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
    myName = pickName();
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
    
    // --- ARCADE RECEIVER ---
    setupReceiver(pc, 
        // 1. On Complete (File Ready)
        ({ blob, name }) => {
            console.log("Arcade Item Ready:", name);
            const url = URL.createObjectURL(blob);
            
            const oldBtn = document.getElementById('arcadeBtn');
            if(oldBtn) oldBtn.remove();

            const btn = document.createElement('a');
            btn.id = 'arcadeBtn';
            btn.href = url;
            btn.download = name;
            btn.innerHTML = `🕹️ <strong>LAUNCH TOOL</strong><br/><small>${name}</small>`;
            btn.className = 'btn primary';
            
            Object.assign(btn.style, {
                position: 'absolute',
                top: '20px', right: '20px',
                zIndex: '2000',
                boxShadow: '0 5px 20px rgba(0,0,0,0.8)',
                textAlign: 'center',
                padding: '10px 20px',
                border: '2px solid #4af3a3'
            });

            const container = document.querySelector('.video-container');
            if(container) container.appendChild(btn);
            
            $('viewerStatus').textContent = 'LIVE'; 
        },
        // 2. On Progress
        (percent) => {
            $('viewerStatus').textContent = `Loading Toolbox: ${percent}%`;
        }
    );

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
    socket.emit('webrtc-answer', { targetId: from, sdp: answer });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// --- CHAT (SECURITY FIX) ---
socket.on('public-chat', ({ name, text, ts }) => {
    const log = $('chatLog');
    const d = document.createElement('div');
    d.className = 'chat-line';
    
    // SECURITY FIX: Create DOM elements
    const strong = document.createElement('strong');
    strong.textContent = name;
    
    const msgText = document.createTextNode(`: ${text}`);
    
    d.appendChild(strong);
    d.appendChild(msgText);
    
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
