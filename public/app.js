// app.js - THE WORKING RESET
const socket = io({ autoConnect: false });

// Variables
let currentRoom = null;
let pc = null;
let localStream = null;
let camOn = true;
let micOn = true;

// STUN Servers (Google's free ones)
const iceConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ] 
};

// DOM Elements
const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const startCallBtn = document.getElementById('startCallBtn');
const hangupBtn = document.getElementById('hangupBtn');
const localVideo = document.getElementById('localVideo');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const streamLinkInput = document.getElementById('streamLinkInput');

// 1. JOIN ROOM
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) return alert("Enter a room name first!");
  
  currentRoom = room;
  socket.connect();
  socket.emit('join-room', { room, name: 'Host' });
  
  joinBtn.disabled = true;
  document.getElementById('roomInfo').textContent = `Room: ${room}`;
  
  // Create Link for Viewer
  const url = new URL(window.location.href);
  url.pathname = '/view.html';
  url.searchParams.set('room', room);
  if (streamLinkInput) streamLinkInput.value = url.toString();
});

// 2. START CAMERA
startCallBtn.addEventListener('click', async () => {
  if (!currentRoom) return alert("Join a room first!");
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Mute yourself so you don't hear echo
    
    startCallBtn.disabled = true;
    startCallBtn.textContent = "Streaming Active";
    if (hangupBtn) hangupBtn.disabled = false;
    
    console.log("Camera started. Waiting for viewers...");
  } catch (err) {
    alert("Camera Error: " + err.message);
  }
});

// 3. THE TRIGGER: New User Joins -> We Call Them
socket.on('user-joined', () => {
  if (localStream) {
    console.log("New viewer found. Calling them now...");
    restartConnection();
  }
});

async function restartConnection() {
  // Reset the connection to fresh state
  if (pc) pc.close();
  pc = new RTCPeerConnection(iceConfig);

  // Send our network details (ICE)
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
    }
  };

  // Add the camera tracks to the call
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Create the "Offer" (The call invitation)
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: pc.localDescription });
  } catch (err) {
    console.error("Offer Error:", err);
  }
}

// 4. BUTTONS (Restored)
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
    // Kill connection
    if (pc) pc.close();
    // Kill camera
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    localVideo.srcObject = null;
    startCallBtn.disabled = false;
    startCallBtn.textContent = 'Start Call';
    hangupBtn.disabled = true;
  });
}

// 5. SIGNALING (Handling the response)
socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// (Optional) Chat and File listeners stay here
socket.on('chat-message', (data) => { /* reuse existing chat logic */ });
