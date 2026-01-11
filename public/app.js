// Rebel Broadcaster (Host Client)
const socket = io({ autoConnect: false });

// UI Elements
const localVideo = document.getElementById('localVideo');
const startCallBtn = document.getElementById('startCallBtn');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const signalStatusEl = document.getElementById('signalStatus');
const streamLinkInput = document.getElementById('streamLinkInput');

// State
let localStream = null;
let currentRoom = null;
let isBroadcasting = false;

// We store multiple connections here: { socketId: RTCPeerConnection }
const peers = {}; 

const iceConfig = { iceServers: ICE_SERVERS || [] };

// --- 1. Connection & Setup ---

joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) return alert('Enter room name');
  
  currentRoom = room;
  socket.connect();
  socket.emit('join-room', { room, name: 'Host' });
  
  // Update UI
  document.getElementById('roomInfo').textContent = `Room: ${room}`;
  joinBtn.disabled = true;
  generateStreamLink(room);
});

function generateStreamLink(room) {
  if (!streamLinkInput) return;
  const url = new URL(window.location.href);
  url.pathname = '/view.html'; // Assumes view.html is next to index.html
  url.searchParams.set('room', room);
  streamLinkInput.value = url.toString();
}

socket.on('connect', () => {
  signalStatusEl.textContent = 'Connected (Host)';
  signalStatusEl.classList.add('status-connected');
});

// --- 2. Broadcast Logic ---

startCallBtn.addEventListener('click', async () => {
  if (!currentRoom) return alert('Join a room first');
  
  try {
    // 1. Get Camera ONLY ONCE
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Mute self to avoid echo
    isBroadcasting = true;
    startCallBtn.disabled = true;
    startCallBtn.textContent = 'Broadcasting...';
    
    // Note: We don't create a connection yet. 
    // We wait for viewers to join, or we could signal existing ones (omitted for simplicity).
    console.log('Stream started. Waiting for viewers...');
  } catch (err) {
    console.error('Camera error:', err);
    alert('Could not start camera');
  }
});

// When a Viewer joins the room
socket.on('user-joined', (viewerId) => {
  console.log('Viewer joined:', viewerId);
  if (isBroadcasting && localStream) {
    // Connect to this specific viewer
    connectToViewer(viewerId);
  }
});

// When a Viewer leaves
socket.on('user-left', (viewerId) => {
  if (peers[viewerId]) {
    console.log('Viewer left, closing connection:', viewerId);
    peers[viewerId].close();
    delete peers[viewerId];
  }
});

// --- 3. WebRTC Handling (One PC per Viewer) ---

async function connectToViewer(viewerId) {
  // Create a dedicated connection for this viewer
  const pc = new RTCPeerConnection(iceConfig);
  peers[viewerId] = pc;

  // Add the camera tracks to this connection
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // ICE Candidates: Send only to this viewer
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        target: viewerId,
        type: 'ice-candidate',
        payload: event.candidate
      });
    }
  };

  // Create Offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Send Offer ONLY to this viewer
    socket.emit('signal', {
      target: viewerId,
      type: 'offer',
      payload: pc.localDescription
    });
  } catch (err) {
    console.error('Offer Error:', err);
  }
}

// Handle responses from Viewers
socket.on('signal', async ({ from, type, payload }) => {
  const pc = peers[from];
  if (!pc) return; // Unknown peer or already closed

  try {
    if (type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } else if (type === 'ice-candidate') {
      await pc.addIceCandidate(new RTCIceCandidate(payload));
    }
  } catch (err) {
    console.error('Signaling Error:', err);
  }
});

// --- Chat/Helpers (Simplified for brevity) ---
// (You can keep your existing chat/file logic, just ensure 
// socket.on('chat-message') is preserved if you want chat)
