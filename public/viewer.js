// Rebel Viewer
const socket = io({ autoConnect: false });
const viewerVideo = document.getElementById('viewerVideo');
const statusEl = document.getElementById('viewerStatus');
let pc = null;
let currentRoom = null;

const iceConfig = { iceServers: ICE_SERVERS || [] };
const urlParams = new URLSearchParams(window.location.search);
const room = urlParams.get('room');

if (room) {
  joinRoom(room);
} else {
  setStatus('No room specified in URL');
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
  console.log(text);
}

function joinRoom(roomName) {
  currentRoom = roomName;
  socket.connect();
  socket.emit('join-room', { room: roomName, name: 'Viewer' });
  setStatus('Waiting for stream...');
}

socket.on('connect', () => {
    // Poke the host just in case they are already there
    // This triggers the 'user-joined' event on the server
    if (currentRoom) {
       // Just being connected is enough, the server handles the join event
    }
});

// --- Receive Signals from Host ---
socket.on('signal', async ({ from, type, payload }) => {
  
  // 1. Offer Received
  if (type === 'offer') {
    setStatus('Stream found! Connecting...');
    await createPeerConnection(from); // 'from' is the Host ID
    await pc.setRemoteDescription(new RTCSessionDescription(payload));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    // Send Answer back to Host
    socket.emit('signal', {
      target: from,
      type: 'answer',
      payload: pc.localDescription
    });
  } 
  
  // 2. ICE Candidate Received
  else if (type === 'ice-candidate') {
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(payload));
  }
});

async function createPeerConnection(hostId) {
  if (pc) pc.close();
  
  pc = new RTCPeerConnection(iceConfig);

  pc.ontrack = (event) => {
    console.log('Video track received');
    viewerVideo.srcObject = event.streams[0];
    setStatus('Live');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        target: hostId,
        type: 'ice-candidate',
        payload: event.candidate
      });
    }
  };
}
