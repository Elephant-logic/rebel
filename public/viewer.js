// VIEWER – watch a stream in a room like ?room=stream-123456

const socket = io();

// DOM
const videoEl = document.getElementById('viewerVideo');
const statusEl = document.getElementById('viewerStatus') || { textContent: '' };

// read ?room= from URL
const url = new URL(window.location.href);
const room = url.searchParams.get('room') || 'default';
const viewerName = 'Viewer-' + Math.floor(Math.random() * 9999);

statusEl.textContent = `Connecting to room: ${room}...`;

// join the room
socket.emit('join-room', { room, name: viewerName });

// PeerConnection for receiving stream
let pc = null;
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

socket.on('connect', () => {
  console.log('viewer connected');
});

socket.on('disconnect', () => {
  console.log('viewer disconnected');
  statusEl.textContent = 'Disconnected from server.';
});

// ---- When host sends an offer for this room ----
socket.on('webrtc-offer', async ({ room: offerRoom, sdp }) => {
  if (offerRoom !== room) {
    // offer for some other room
    return;
  }
  console.log('Got offer for room', offerRoom);

  try {
    // create PC if not already
    if (pc) {
      pc.close();
      pc = null;
    }
    pc = new RTCPeerConnection(iceConfig);

    pc.ontrack = (e) => {
      console.log('viewer ontrack', e.streams);
      if (videoEl) {
        videoEl.srcObject = e.streams[0];
      }
      statusEl.textContent = 'Live 🔴';
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('webrtc-ice-candidate', {
          room,
          candidate: e.candidate
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      room,
      sdp: pc.localDescription
    });

    statusEl.textContent = 'Negotiating stream...';
  } catch (err) {
    console.error('Error handling offer on viewer', err);
    statusEl.textContent = 'Error joining stream.';
  }
});

// ---- ICE from host → viewer ----
socket.on('webrtc-ice-candidate', async ({ room: iceRoom, candidate }) => {
  if (iceRoom !== room) return;
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding ICE candidate on viewer', err);
  }
});

// optional: handle user-joined / user-left (debug)
socket.on('user-joined', ({ room: joinRoom, name, id }) => {
  console.log('user joined viewer room', joinRoom, name, id);
});

socket.on('user-left', ({ room: leftRoom, id }) => {
  console.log('user left viewer room', leftRoom, id);
});
