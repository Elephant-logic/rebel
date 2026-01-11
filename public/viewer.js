// Rebel Stream Viewer
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
}

async function ensureConnected() {
  return new Promise(resolve => {
    if (socket.connected) return resolve();
    socket.connect();
    socket.once('connect', () => resolve());
  });
}

async function joinRoom() {
  await ensureConnected();
  currentRoom = room;
  const name = `Viewer-${Math.floor(Math.random() * 10000)}`;
  socket.emit('join-room', { room, name });
  if (viewerRoomEl) viewerRoomEl.textContent = `Room: ${room}`;
  setStatus('Waiting for host…');
}

async function createPeerConnection() {
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.close();
    pc = null;
  }

  pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate && currentRoom) {
      socket.emit('webrtc-ice-candidate', {
        room: currentRoom,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    viewerVideo.srcObject = event.streams[0];
    setStatus('Live');
  };
}

async function handleOffer({ sdp }) {
  await createPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { room: currentRoom, answer: pc.localDescription });
  setStatus('Connected');
}

function handleIceCandidate(candidate) {
  if (pc) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
      console.error('ICE add error', err);
    });
  }
}

socket.on('connect', () => setStatus('Connected to signal server'));
socket.on('disconnect', () => setStatus('Disconnected'));

socket.on('webrtc-offer', (payload) => {
  handleOffer(payload).catch(err => {
    console.error('Viewer offer error', err);
    setStatus('Error receiving stream');
  });
});

socket.on('webrtc-ice-candidate', ({ candidate }) => {
  handleIceCandidate(candidate);
});

joinRoom().catch(err => {
  console.error('Viewer join error', err);
  setStatus('Error joining room');
});
