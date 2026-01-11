const socket = io({ autoConnect: false });

// STATE
let currentRoom = null;
let userName = 'User';
let localStream = null;
let peers = {}; // Format: { socketId: { pc, dataChannel, queue } }
let mode = 'IDLE'; // 'CALL' or 'STREAM'
let fileChunks = []; // For receiving files

// ICE CONFIG
const iceConfig = (typeof ICE_SERVERS !== 'undefined') 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM ELEMENTS
const get = (id) => document.getElementById(id);
const localVideo = get('localVideo');
const videoGrid = get('videoGrid');
const startCallBtn = get('startCallBtn');
const startStreamBtn = get('startStreamBtn');
const hangupBtn = get('hangupBtn');
const transferStatus = get('transferStatus');

// --- 1. SETTINGS & MEDIA ---

async function getMedia(constraints) {
  try {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    return localStream;
  } catch (e) {
    console.error('Media Error:', e);
    alert('Could not access Camera/Mic');
    return null;
  }
}

// Populate Settings Modal
async function loadDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = get('camSelect');
  const mics = get('micSelect');
  cams.innerHTML = ''; mics.innerHTML = '';

  devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0,5)}`;
    if (d.kind === 'videoinput') cams.appendChild(opt);
    else if (d.kind === 'audioinput') mics.appendChild(opt);
  });
}

get('settingsBtn').onclick = () => {
    loadDevices();
    get('settingsModal').style.display = 'flex';
};
get('closeSettings').onclick = () => get('settingsModal').style.display = 'none';

// --- 2. JOINING ---

get('joinBtn').onclick = () => {
  const room = get('roomInput').value.trim();
  userName = get('nameInput').value.trim() || 'Anon';
  if(!room) return alert("Enter Room Name");
  
  currentRoom = room;
  socket.connect();
  socket.emit('join-room', { room, name: userName });
  
  get('joinBtn').disabled = true;
  startCallBtn.disabled = false;
  startStreamBtn.disabled = false;
};

// --- 3. MODES (CALL VS STREAM) ---

startCallBtn.onclick = async () => {
  mode = 'CALL';
  await startSession(true); // Bidirectional
};

startStreamBtn.onclick = async () => {
  mode = 'STREAM';
  await startSession(false); // Unidirectional (Host -> Viewers)
};

async function startSession(bidirectional) {
  // Get Media based on Selection
  const camId = get('camSelect').value;
  const micId = get('micSelect').value;
  
  const constraints = {
    video: camId ? { deviceId: { exact: camId } } : true,
    audio: micId ? { deviceId: { exact: micId } } : true
  };
  
  await getMedia(constraints);
  
  // UI Updates
  startCallBtn.disabled = true;
  startStreamBtn.disabled = true;
  hangupBtn.disabled = false;
  get('modeDisplay').textContent = mode;
  get('modeDisplay').className = mode === 'CALL' ? 'mode-badge mode-call' : 'mode-badge mode-stream';

  // In CALL mode, we signal everyone we are ready
  // In STREAM mode, we wait for viewers to join, or connect to existing
  socket.emit('session-active', { mode });
}

hangupBtn.onclick = () => {
  location.reload(); // Simplest way to clean up Mesh networking state
};

// --- 4. PEER CONNECTION LOGIC (MESH) ---

socket.on('existing-users', (users) => {
  // When we join, we see who is already there
  users.forEach(u => {
    if (u.id !== socket.id) createPeer(u.id, u.name, true); // We are initiator
  });
});

socket.on('user-joined', ({ id, name }) => {
  console.log('User joined:', name);
  createPeer(id, name, false); // They joined, so they might initiate, or we wait
});

socket.on('user-left', ({ id }) => {
  if (peers[id]) {
    peers[id].pc.close();
    delete peers[id];
    const el = document.getElementById(`vid_${id}`);
    if (el) el.remove();
  }
});

// CORE PEER CREATION
function createPeer(targetId, name, initiator) {
  if (peers[targetId]) return; // Already connected

  const pc = new RTCPeerConnection(iceConfig);
  peers[targetId] = { pc, dataChannel: null };

  // 1. Add Local Tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // 2. Handle Remote Tracks
  pc.ontrack = (e) => {
    let vid = document.getElementById(`vid_${targetId}`);
    if (!vid) {
      // Create Video Element Dynamically
      const card = document.createElement('div');
      card.className = 'video-card';
      card.id = `vid_${targetId}`;
      card.innerHTML = `<h2>${name}</h2><video autoplay playsinline></video>`;
      videoGrid.appendChild(card);
      vid = card.querySelector('video');
    }
    vid.srcObject = e.streams[0];
  };

  // 3. ICE Handling
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', { 
        room: currentRoom, 
        target: targetId, 
        candidate: e.candidate 
      });
    }
  };

  // 4. Data Channel (File Share)
  if (initiator) {
    const dc = pc.createDataChannel("files");
    setupDataChannel(dc, targetId);
    peers[targetId].dataChannel = dc;
    
    // Create Offer
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { room: currentRoom, target: targetId, sdp: offer });
    });
  } else {
    pc.ondatachannel = (e) => {
      setupDataChannel(e.channel, targetId);
      peers[targetId].dataChannel = e.channel;
    };
  }

  return pc;
}

// --- 5. SIGNALING HANDLERS ---

socket.on('webrtc-offer', async ({ sender, sdp }) => {
  let peer = peers[sender];
  if (!peer) {
    // If we receive an offer from someone we didn't initiate to
    createPeer(sender, 'Peer', false);
    peer = peers[sender];
  }
  
  await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  
  // If STREAM mode and we are viewer, we only receive.
  // If CALL mode, we answer with our video.
  if (mode === 'IDLE' || mode === 'CALL') {
     // Ensure we have media if we are in a call
     if(!localStream && mode === 'CALL') {
        // Auto-join audio/video if not started? (Optional logic)
     }
  }

  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { room: currentRoom, target: sender, sdp: answer });
});

socket.on('webrtc-answer', async ({ sender, sdp }) => {
  const peer = peers[sender];
  if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ sender, candidate }) => {
  const peer = peers[sender];
  if (peer) await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// --- 6. FILE SHARE (DATA CHANNEL CHUNKING) ---

const CHUNK_SIZE = 16384; // 16KB

function setupDataChannel(dc, id) {
  let receivedBuffers = [];
  let receivedSize = 0;
  let fileMeta = null;

  dc.onmessage = (e) => {
    const data = e.data;
    
    // If string, it's metadata
    if (typeof data === 'string') {
      fileMeta = JSON.parse(data);
      receivedBuffers = [];
      receivedSize = 0;
      transferStatus.textContent = `Receiving ${fileMeta.name}...`;
    } else {
      // Binary chunk
      receivedBuffers.push(data);
      receivedSize += data.byteLength;
      
      if (fileMeta && receivedSize >= fileMeta.size) {
        // Complete
        const blob = new Blob(receivedBuffers, { type: fileMeta.type });
        const url = URL.createObjectURL(blob);
        appendChat('System', `<a href="${url}" download="${fileMeta.name}" style="color:#4af3a3">💾 Download ${fileMeta.name}</a>`);
        transferStatus.textContent = '';
        receivedBuffers = [];
      }
    }
  };
}

// File UI
get('fileInput').onchange = (e) => {
  const f = e.target.files[0];
  if(f) {
    get('fileName').textContent = f.name;
    get('sendFileBtn').disabled = false;
  }
};

get('sendFileBtn').onclick = () => {
  const file = get('fileInput').files[0];
  if (!file) return;

  const meta = JSON.stringify({ name: file.name, type: file.type, size: file.size });
  
  // Send to ALL connected peers
  Object.values(peers).forEach(({ dataChannel }) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(meta);
      
      const reader = new FileReader();
      let offset = 0;
      
      reader.onload = (e) => {
        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        if (offset < file.size) {
          readSlice(offset);
        } else {
          transferStatus.textContent = 'Sent!';
          setTimeout(() => transferStatus.textContent='', 2000);
        }
      };

      const readSlice = (o) => {
        const slice = file.slice(o, o + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
      };
      readSlice(0);
    }
  });
  
  appendChat('You', `Shared file: ${file.name}`);
};

// --- 7. CHAT (Existing Logic) ---
socket.on('chat-message', (data) => appendChat(data.name, data.text));
get('sendBtn').onclick = () => {
    const txt = get('chatInput').value;
    if(txt) {
        socket.emit('chat-message', { room: currentRoom, name: userName, text: txt });
        appendChat('You', txt);
        get('chatInput').value = '';
    }
};

function appendChat(name, text) {
  const div = document.createElement('div');
  div.className = 'chat-line';
  div.innerHTML = `<strong>${name}:</strong> ${text}`;
  get('chatLog').appendChild(div);
  get('chatLog').scrollTop = get('chatLog').scrollHeight;
}
