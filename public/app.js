const socket = io({ autoConnect: false });

let currentRoom = null;
let userName = null;
let pc = null;
let localStream = null;
let camOn = true;
let micOn = true;

const iceConfig = { iceServers: ICE_SERVERS || [] };

// DOM Elements
const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const nameInput = document.getElementById('nameInput');
const startCallBtn = document.getElementById('startCallBtn');
const hangupBtn = document.getElementById('hangupBtn'); // Make sure this ID exists in HTML
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const streamLinkInput = document.getElementById('streamLinkInput');

// 1. Join Room
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  const name = nameInput.value.trim() || 'Host';
  if (!room) return alert('Enter Room Name');
  
  currentRoom = room;
  socket.connect();
  socket.emit('join-room', { room, name });
  
  joinBtn.disabled = true;
  document.getElementById('roomInfo').textContent = `Room: ${room}`;
  
  // Generate Link
  const url = new URL(window.location.href);
  url.pathname = '/view.html';
  url.searchParams.set('room', room);
  if (streamLinkInput) streamLinkInput.value = url.toString();
});

// 2. Start Camera (Only happens once)
startCallBtn.addEventListener('click', async () => {
  if (!currentRoom) return alert('Join Room First');
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Mute self
    
    startCallBtn.disabled = true;
    startCallBtn.textContent = 'Streaming...';
    if (hangupBtn) hangupBtn.disabled = false;

    // Optional: Try connecting immediately in case viewer is waiting
    restartConnection();
  } catch (err) {
    alert('Camera Error: ' + err.message);
  }
});

// 3. THE MAGIC: User Joins -> Restart Connection
socket.on('user-joined', () => {
  if (localStream) {
    console.log('New viewer detected. Connecting...');
    restartConnection();
  }
});

async function restartConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  // Send Ice Candidates
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
  };
  
  // Add Tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Create Offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (err) {
    console.error(err);
  }
}

// 4. Buttons (Cam/Mic)
if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    toggleCamBtn.textContent = camOn ? 'Camera Off' : 'Camera On';
  });
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    toggleMicBtn.textContent = micOn ? 'Mute' : 'Unmute';
  });
}

if (hangupBtn) {
  hangupBtn.addEventListener('click', () => {
    if (pc) pc.close();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    startCallBtn.disabled = false;
    startCallBtn.textContent = 'Start Call';
    hangupBtn.disabled = true;
  });
}

// 5. Signaling Handling
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// Chat (Keep your existing chat listeners here if needed)
