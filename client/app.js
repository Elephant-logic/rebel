const signalBadge = document.getElementById('signalBadge');
const roomBadge = document.getElementById('roomBadge');
const statusLine = document.getElementById('statusLine');

const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');

const startCallBtn = document.getElementById('startCallBtn');
const endCallBtn = document.getElementById('endCallBtn');
const muteBtn = document.getElementById('muteBtn');
const cameraBtn = document.getElementById('cameraBtn');

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

const DEFAULT_SIGNAL_URL =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/signal';

let ws;
let currentRoom = null;
let roomReady = false;

let localStream = null;
let pc = null;
let audioMuted = false;
let videoMuted = false;

function logStatus(msg) {
  console.log('[RM]', msg);
  statusLine.textContent = msg;
}

function setSignalState(online) {
  if (online) {
    signalBadge.textContent = 'Signal: connected';
    signalBadge.style.borderColor = '#3effa2';
    signalBadge.style.color = '#3effa2';
  } else {
    signalBadge.textContent = 'Signal: offline';
    signalBadge.style.borderColor = '#ff4b6e';
    signalBadge.style.color = '#ffb0c3';
  }
}

function setRoom(room) {
  currentRoom = room;
  if (room) {
    roomBadge.textContent = 'Room: ' + room;
  } else {
    roomBadge.textContent = 'No room';
  }
}

function appendChatLine(from, text, self = false) {
  const div = document.createElement('div');
  div.className = 'chat-line ' + (self ? 'self' : 'peer');
  const fromSpan = document.createElement('span');
  fromSpan.className = 'from';
  fromSpan.textContent = from + ':';
  const textSpan = document.createElement('span');
  textSpan.className = 'text';
  textSpan.textContent = ' ' + text;
  div.appendChild(fromSpan);
  div.appendChild(textSpan);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function ensureSignalSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(DEFAULT_SIGNAL_URL);

  ws.onopen = () => {
    setSignalState(true);
    logStatus('Signal connected.');
    if (currentRoom) {
      ws.send(JSON.stringify({ type: 'join', room: currentRoom }));
    }
  };

  ws.onclose = () => {
    setSignalState(false);
    logStatus('Signal disconnected.');
  };

  ws.onerror = (err) => {
    console.error('WS error', err);
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'joined':
        logStatus('Joined room ' + msg.room + '. Waiting for peer…');
        break;

      case 'room-ready':
        roomReady = true;
        logStatus('Peer connected. You can start a call.');
        break;

      case 'peer-left':
        logStatus('Peer left the room.');
        roomReady = false;
        teardownPeerConnection();
        break;

      case 'signal':
        await handleSignal(msg.payload);
        break;

      case 'chat':
        appendChatLine(msg.from || 'peer', msg.text || '', false);
        break;

      case 'room-full':
        logStatus('Room already has 2 peers. Pick another name.');
        break;

      default:
        console.log('WS message', msg);
    }
  };
}

async function getLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    localVideo.srcObject = localStream;
    return localStream;
  } catch (err) {
    console.error('getUserMedia failed', err);
    alert('Could not access camera/mic: ' + err.message);
    throw err;
  }
}

function createPeerConnection() {
  if (pc) return pc;

  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };

  pc = new RTCPeerConnection(config);

  pc.onicecandidate = (event) => {
    if (event.candidate && currentRoom && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'signal',
          room: currentRoom,
          payload: { type: 'candidate', candidate: event.candidate },
        }),
      );
    }
  };

  pc.ontrack = (event) => {
    console.log('Remote track received');
    remoteVideo.srcObject = event.streams[0];
  };

  pc.onconnectionstatechange = () => {
    console.log('PC state', pc.connectionState);
    if (pc.connectionState === 'connected') {
      logStatus('Call connected.');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      logStatus('Call ended.');
    }
  };

  return pc;
}

async function startOfferFlow() {
  if (!currentRoom) {
    alert('Join a room first.');
    return;
  }
  if (!roomReady) {
    logStatus('Waiting for peer to join before starting call…');
    return;
  }
  ensureSignalSocket();
  const stream = await getLocalStream();
  const pcLocal = createPeerConnection();

  stream.getTracks().forEach((track) => {
    pcLocal.addTrack(track, stream);
  });

  const offer = await pcLocal.createOffer();
  await pcLocal.setLocalDescription(offer);

  ws.send(
    JSON.stringify({
      type: 'signal',
      room: currentRoom,
      payload: offer,
    }),
  );

  logStatus('Offer sent. Waiting for answer…');
}

async function handleSignal(payload) {
  if (!pc && payload.type !== 'offer' && payload.type !== 'answer' && payload.type !== 'candidate') {
    return;
  }

  if (payload.type === 'offer') {
    ensureSignalSocket();
    const stream = await getLocalStream();
    const pcLocal = createPeerConnection();
    stream.getTracks().forEach((track) => pcLocal.addTrack(track, stream));

    await pcLocal.setRemoteDescription(new RTCSessionDescription(payload));
    const answer = await pcLocal.createAnswer();
    await pcLocal.setLocalDescription(answer);

    ws.send(
      JSON.stringify({
        type: 'signal',
        room: currentRoom,
        payload: answer,
      }),
    );
    logStatus('Answer sent.');
  } else if (payload.type === 'answer') {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(payload));
    logStatus('Answer received. Connecting…');
  } else if (payload.type === 'candidate') {
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } catch (err) {
      console.error('Error adding ice candidate', err);
    }
  }
}

function teardownPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (remoteVideo.srcObject) {
    remoteVideo.srcObject.getTracks().forEach((t) => t.stop());
    remoteVideo.srcObject = null;
  }
}

// --- UI bindings -----------------------------------------------------------

joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Enter a room name.');
    return;
  }
  ensureSignalSocket();
  roomReady = false;
  setRoom(room);
  ws.send(JSON.stringify({ type: 'join', room }));
  logStatus('Joining room ' + room + '…');
});

leaveBtn.addEventListener('click', () => {
  setRoom(null);
  roomReady = false;
  teardownPeerConnection();
  logStatus('Left room.');
});

startCallBtn.addEventListener('click', () => {
  startOfferFlow().catch((err) => console.error(err));
});

endCallBtn.addEventListener('click', () => {
  teardownPeerConnection();
  logStatus('Call ended.');
});

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  audioMuted = !audioMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !audioMuted));
  muteBtn.textContent = audioMuted ? 'Unmute' : 'Mute';
});

cameraBtn.addEventListener('click', () => {
  if (!localStream) return;
  videoMuted = !videoMuted;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !videoMuted));
  cameraBtn.textContent = videoMuted ? 'Camera On' : 'Camera Off';
});

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChat();
  }
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoom || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'chat',
      room: currentRoom,
      payload: { from: 'you', text },
    }),
  );
  appendChatLine('you', text, true);
  chatInput.value = '';
}

window.addEventListener('load', () => {
  setSignalState(false);
  logStatus('Ready. Join a room to begin.');
});