// viewer.js - Full File
const socket = io({ autoConnect: false });

let pc = null;
let currentRoom = null;

const viewerVideo = document.getElementById('viewerVideo');
const viewerRoomEl = document.getElementById('viewerRoom');
const viewerStatusEl = document.getElementById('viewerStatus');

const urlParams = new URLSearchParams(window.location.search);
const room = urlParams.get('room') || 'main';

const iceConfig = { iceServers: ICE_SERVERS || [] };

function setStatus(text) {
  if (viewerStatusEl) viewerStatusEl.textContent = text;
  console.log('Status:', text);
}

// 1. Join
socket.connect();
currentRoom = room;
if (viewerRoomEl) viewerRoomEl.textContent = `Room: ${room}`;
setStatus('Connecting to server...');

socket.on('connect', () => {
  setStatus('Connected. Joining room...');
  socket.emit('join-room', { room, name: `Viewer-${Math.floor(Math.random()*1000)}` });
  
  // Retry / Poke logic: If we don't get a stream in 2 seconds, tell the host we are here
  setTimeout(() => {
    if (!pc) {
      console.log('No stream yet, sending manual join signal...');
      socket.emit('join-room', { room, name: 'Viewer-Retry' });
    }
  }, 2000);
});

socket.on('disconnect', () => setStatus('Disconnected'));

// 2. Receive Offer
socket.on('webrtc-offer', async ({ sdp }) => {
  setStatus('Stream found! Negotiating...');
  
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    console.log('Track received');
    viewerVideo.srcObject = event.streams[0];
    setStatus('Live');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: event.candidate });
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { room: currentRoom, sdp: pc.localDescription });
  } catch (err) {
    console.error('Offer Error:', err);
    setStatus('Error negotiating');
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) { console.error(err); }
  }
});
