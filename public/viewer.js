const socket = io({ autoConnect: false });
let pc = null;
let currentRoom = null;
const iceConfig = { iceServers: ICE_SERVERS || [] };

const viewerVideo = document.getElementById('viewerVideo');
const statusEl = document.getElementById('viewerStatus');

// Join from URL
const params = new URLSearchParams(window.location.search);
const room = params.get('room');

if (room) {
  currentRoom = room;
  socket.connect();
  setStatus('Connecting...');
}

socket.on('connect', () => {
  setStatus('Waiting for stream...');
  socket.emit('join-room', { room: currentRoom, name: 'Viewer' });
});

// Listen for Offer
socket.on('webrtc-offer', async ({ sdp }) => {
  setStatus('Stream found!');
  
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    viewerVideo.srcObject = event.streams[0];
    setStatus('Live');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: event.candidate });
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { room: currentRoom, sdp: pc.localDescription });
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
  console.log(text);
}
