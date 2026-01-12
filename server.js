const socket = io({ autoConnect: false });
let pc = null;
let currentRoom = null;

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = id => document.getElementById(id);
const viewerVideo = $('viewerVideo');
const statusText = $('viewerStatus');
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');

// 1. INIT
(function init() {
    const params = new URLSearchParams(window.location.search);
    currentRoom = params.get('room');
    if (!currentRoom) {
        if(statusText) statusText.textContent = "Error: No Room ID";
        return;
    }
    
    socket.connect();
    socket.emit('join-room', { room: currentRoom, name: 'Viewer-' + Math.floor(Math.random()*1000) });
    if(statusText) statusText.textContent = "Connecting...";
})();

// 2. WEBRTC HANDSHAKE
socket.on('webrtc-offer', async ({ sdp }) => {
    if(pc) pc.close();
    pc = new RTCPeerConnection(iceConfig);

    pc.onicecandidate = e => {
        if(e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
    };

    pc.ontrack = e => {
        if(viewerVideo) {
            viewerVideo.srcObject = e.streams[0];
            if(statusText) statusText.textContent = "LIVE";
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.emit('webrtc-answer', { room: currentRoom, sdp: answer });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if(pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){}
    }
});

// 3. CHAT & METADATA
socket.on('chat-message', d => {
    if(chatLog) {
        const div = document.createElement('div');
        div.style.marginBottom = "4px";
        div.innerHTML = `<strong>${d.name}:</strong> ${d.text}`;
        chatLog.appendChild(div);
        chatLog.scrollTop = chatLog.scrollHeight;
    }
});

if(sendBtn) sendBtn.addEventListener('click', () => {
    if(chatInput && chatInput.value) {
        socket.emit('chat-message', { room: currentRoom, name: 'Viewer', text: chatInput.value, fromViewer: true });
        chatInput.value = '';
    }
});

socket.on('room-update', d => {
    document.title = d.streamTitle || 'Stream';
    const h = document.querySelector('.viewer-header strong');
    if(h) h.textContent = d.streamTitle || 'Rebel Stream';
});
