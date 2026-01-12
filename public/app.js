// REBEL MESSENGER CLIENT - FULL
const socket = io({ autoConnect: false });

// --- STATE ---
let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;

// Media
let localStream = null;
let isScreenSharing = false;
let screenStream = null;

// Streaming (Host -> Viewer)
let pc = null;
let isStreaming = false;
let broadcastStream = null;

// Calling (P2P Mesh)
const callPeers = {}; // { id: { pc, name, iceQueue } }

// Config
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) 
  ? { iceServers: ICE_SERVERS } 
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Helpers
const $ = id => document.getElementById(id);

// --- 1. MEDIA & SETTINGS ---
async function getMedia(constraints) {
    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
        console.error(e);
        alert("Camera/Mic blocked. Check permissions.");
        return null;
    }
}

async function getDevices() {
    try {
        // Request perm to get labels
        const t = await navigator.mediaDevices.getUserMedia({audio:true, video:true}).catch(()=>{});
        if(t) t.getTracks().forEach(tr=>tr.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audios = devices.filter(d => d.kind === 'audioinput');
        const videos = devices.filter(d => d.kind === 'videoinput');
        
        if($('audioSource')) $('audioSource').innerHTML = audios.map(d => `<option value="${d.deviceId}">${d.label||'Mic '+d.deviceId.slice(0,4)}</option>`).join('');
        if($('videoSource')) $('videoSource').innerHTML = videos.map(d => `<option value="${d.deviceId}">${d.label||'Cam '+d.deviceId.slice(0,4)}</option>`).join('');
    } catch(e) { console.error(e); }
}

async function ensureLocalStream() {
    if(localStream && localStream.active) return localStream;
    
    const aId = $('audioSource') ? $('audioSource').value : undefined;
    const vId = $('videoSource') ? $('videoSource').value : undefined;
    
    const constraints = {
        audio: aId ? { deviceId: { exact: aId } } : true,
        video: vId ? { deviceId: { exact: vId } } : true
    };
    
    localStream = await getMedia(constraints);
    if(localStream && $('localVideo')) {
        $('localVideo').srcObject = localStream;
        $('localVideo').muted = true;
    }
    return localStream;
}

// Switch Media (Hot Swap)
async function switchMedia() {
    if(localStream) localStream.getTracks().forEach(t=>t.stop());
    await ensureLocalStream();
    
    if(localStream) {
        const vt = localStream.getVideoTracks()[0];
        const at = localStream.getAudioTracks()[0];
        
        const replace = (conn) => {
             if(!conn) return;
             const vs = conn.getSenders().find(s=>s.track && s.track.kind==='video');
             const as = conn.getSenders().find(s=>s.track && s.track.kind==='audio');
             if(vs && vt) vs.replaceTrack(vt).catch(()=>{});
             if(as && at) as.replaceTrack(at).catch(()=>{});
        };
        
        if(isStreaming && pc && !isScreenSharing) replace(pc);
        Object.values(callPeers).forEach(p => replace(p.pc));
    }
}

if($('settingsBtn')) $('settingsBtn').addEventListener('click', async () => {
    const p = $('settingsPanel');
    if(p.style.display==='none') { p.style.display='block'; await getDevices(); }
    else { p.style.display='none'; }
});
if($('closeSettingsBtn')) $('closeSettingsBtn').addEventListener('click', () => {
    $('settingsPanel').style.display='none';
    switchMedia();
});


// --- 2. HOST STREAMING (Broadcast) ---
if($('startStreamBtn')) $('startStreamBtn').addEventListener('click', async () => {
    if(!iAmHost) return alert("Host only");
    
    if(pc) pc.close();
    pc = new RTCPeerConnection(iceConfig);
    
    // Check quality option
    const q = $('streamQuality') ? $('streamQuality').value : '720';
    
    if(q === 'screen') {
        try {
            broadcastStream = await navigator.mediaDevices.getDisplayMedia({video:true, audio:true});
            isScreenSharing = true;
        } catch(e) { return; }
    } else {
        await ensureLocalStream();
        broadcastStream = localStream;
        isScreenSharing = false;
        // Apply res
        try {
             const h = parseInt(q) || 720;
             broadcastStream.getVideoTracks()[0].applyConstraints({height:{ideal:h}});
        } catch(e){}
    }
    
    broadcastStream.getTracks().forEach(t => pc.addTrack(t, broadcastStream));
    
    pc.onicecandidate = e => {
        if(e.candidate) socket.emit('webrtc-ice-candidate', { room: currentRoom, candidate: e.candidate });
    };
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { room: currentRoom, sdp: offer });
    
    isStreaming = true;
    $('startStreamBtn').textContent = 'Live';
    $('startStreamBtn').classList.add('danger');
    if($('hangupBtn')) $('hangupBtn').disabled = false;
});

// Handshake
socket.on('webrtc-answer', async (d) => {
    if(pc) try { await pc.setRemoteDescription(new RTCSessionDescription(d.sdp)); } catch(e){}
});
socket.on('webrtc-ice-candidate', async (d) => {
    if(pc) try { await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch(e){}
});


// --- 3. P2P CALLING (Mesh) ---
function createPeer(id, name) {
    const cp = new RTCPeerConnection(iceConfig);
    callPeers[id] = { pc: cp, name: name, iceQueue: [] };
    
    cp.onicecandidate = e => { if(e.candidate) socket.emit('call-ice', { targetId: id, candidate: e.candidate }); };
    
    cp.ontrack = e => {
        const grid = $('videoGrid');
        if(!grid.querySelector(`#vid-${id}`)) {
            const div = document.createElement('div');
            div.id = `vid-${id}`;
            div.className = 'video-container';
            div.innerHTML = `<h2>${name}</h2><video autoplay playsinline></video>`;
            grid.appendChild(div);
            div.querySelector('video').srcObject = e.streams[0];
        }
    };
    return cp;
}

window.startCall = async (id) => {
    const s = await ensureLocalStream();
    if(!s) return;
    
    const el = document.querySelector(`[data-userid="${id}"]`);
    const name = el ? el.dataset.username : 'Peer';
    
    const cp = createPeer(id, name);
    s.getTracks().forEach(t => cp.addTrack(t, s));
    
    const offer = await cp.createOffer();
    await cp.setLocalDescription(offer);
    socket.emit('call-offer', { targetId: id, offer });
    
    updateCallBtn(id, true);
};

window.endPeerCall = (id, remote=false) => {
    if(callPeers[id]) { callPeers[id].pc.close(); delete callPeers[id]; }
    const el = document.getElementById(`vid-${id}`);
    if(el) el.remove();
    if(!remote) socket.emit('call-end', { targetId: id });
    updateCallBtn(id, false);
};

function updateCallBtn(id, inCall) {
    const el = document.querySelector(`[data-userid="${id}"]`);
    if(!el) return;
    const btn = el.querySelector('button');
    if(btn) {
        btn.textContent = inCall ? 'End' : '📞 Call';
        btn.className = inCall ? 'action-btn danger' : 'action-btn';
        btn.setAttribute('onclick', inCall ? `endPeerCall('${id}')` : `startCall('${id}')`);
    }
}

// Call Events
socket.on('ring-alert', d => { if(confirm(`${d.from} is calling!`)) startCall(d.fromId); });
socket.on('incoming-call', async d => {
    const s = await ensureLocalStream();
    const cp = createPeer(d.from, d.name);
    await cp.setRemoteDescription(new RTCSessionDescription(d.offer));
    s.getTracks().forEach(t => cp.addTrack(t, s));
    const ans = await cp.createAnswer();
    await cp.setLocalDescription(ans);
    socket.emit('call-answer', { targetId: d.from, answer: ans });
    callPeers[d.from].iceQueue.forEach(c => cp.addIceCandidate(c));
    updateCallBtn(d.from, true);
});
socket.on('call-answer', async d => {
    const p = callPeers[d.from];
    if(p) { await p.pc.setRemoteDescription(new RTCSessionDescription(d.answer)); p.iceQueue.forEach(c => p.pc.addIceCandidate(c)); }
});
socket.on('call-ice', d => {
    const p = callPeers[d.from];
    if(p) { p.pc.remoteDescription ? p.pc.addIceCandidate(new RTCIceCandidate(d.candidate)) : p.iceQueue.push(new RTCIceCandidate(d.candidate)); }
});
socket.on('call-end', d => endPeerCall(d.from, true));


// --- 4. FILES & CHAT ---
if($('fileInput')) $('fileInput').addEventListener('change', () => {
    const f = $('fileInput').files[0];
    if(f) { $('fileNameLabel').textContent = f.name; $('sendFileBtn').disabled = false; }
});
if($('sendFileBtn')) $('sendFileBtn').addEventListener('click', () => {
    const f = $('fileInput').files[0];
    if(!f) return;
    if(f.size > 50*1024*1024) return alert("File too large (>50MB)");
    const r = new FileReader();
    r.onload = e => {
        socket.emit('file-share', { room: currentRoom, name: userName, fileName: f.name, fileData: e.target.result });
        appendFile('You', f.name, e.target.result);
        $('fileInput').value = ''; $('sendFileBtn').disabled=true; $('fileNameLabel').textContent='Sent!';
    };
    r.readAsDataURL(f);
});

socket.on('file-share', d => appendFile(d.name, d.fileName, d.fileData));

function appendFile(who, fname, data) {
    if(!$('fileLog')) return;
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `<div><strong>${who}</strong>: ${fname}</div><a href="${data}" download="${fname}" class="btn small">Download</a>`;
    $('fileLog').appendChild(div);
}

if($('sendBtn')) $('sendBtn').addEventListener('click', () => {
    const t = $('chatInput').value;
    if(t) { socket.emit('chat-message', { room: currentRoom, name: userName, text: t }); $('chatInput').value=''; }
});
if($('emojiStrip')) $('emojiStrip').addEventListener('click', e => {
    if(e.target.classList.contains('emoji')) { $('chatInput').value += e.target.textContent; $('chatInput').focus(); }
});
socket.on('chat-message', d => {
    const l = $('chatLog');
    if(l) {
        const div = document.createElement('div');
        div.className = 'chat-line';
        div.innerHTML = `<strong>${d.name}:</strong> ${d.text}`;
        l.appendChild(div);
        l.scrollTop = l.scrollHeight;
    }
});


// --- 5. ROOM & UI UPDATES ---
socket.on('connect', () => { if($('signalStatus')) $('signalStatus').className = 'status-dot status-connected'; myId = socket.id; });
socket.on('room-update', d => {
    iAmHost = (d.ownerId === myId);
    if($('hostControls')) $('hostControls').style.display = iAmHost ? 'block' : 'none';
    if(iAmHost) {
        if($('streamTitleInput')) $('streamTitleInput').value = d.streamTitle||'';
        if($('slugInput')) $('slugInput').value = d.publicSlug||'';
    }
    if($('streamLinkInput')) {
        const id = d.publicSlug || currentRoom;
        const url = new URL(window.location.href);
        url.pathname = url.pathname.replace('index.html', '') + 'view.html';
        url.search = `?room=${encodeURIComponent(id)}`;
        $('streamLinkInput').value = url.toString();
    }
    if($('lockRoomBtn')) $('lockRoomBtn').textContent = d.locked ? '🔒 Unlock' : '🔓 Lock';

    // User List
    const l = $('userList');
    if(l) {
        l.innerHTML = '';
        d.users.forEach(u => {
            if(u.id === myId) return;
            const inCall = !!callPeers[u.id];
            const div = document.createElement('div');
            div.className = 'user-item';
            div.dataset.userid = u.id;
            div.dataset.username = u.name;
            div.innerHTML = `<span>${u.id===d.ownerId?'👑':''} ${u.name}</span>
            <div class="user-actions">
              <button onclick="${inCall?`endPeerCall('${u.id}')`:`startCall('${u.id}')`}" class="${inCall?'action-btn danger':'action-btn'}">${inCall?'End':'📞 Call'}</button>
              ${iAmHost ? `<button onclick="kickUser('${u.id}')" class="action-btn kick">Kick</button>` : ''}
            </div>`;
            l.appendChild(div);
        });
    }
});

socket.on('role', d => { iAmHost = d.isHost; });
socket.on('user-joined', d => { if($('chatLog')) { const div=document.createElement('div'); div.innerHTML=`<i>${d.name} joined</i>`; $('chatLog').appendChild(div); } });
socket.on('kicked', () => location.reload());

// --- 6. INIT ---
if($('joinBtn')) $('joinBtn').addEventListener('click', () => {
   const r = $('roomInput').value.trim();
   if(!r) return;
   currentRoom = r;
   userName = $('nameInput').value || 'Anon';
   socket.connect();
   socket.emit('join-room', { room: r, name: userName });
   $('joinBtn').disabled = true;
   ensureLocalStream();
});
if($('leaveBtn')) $('leaveBtn').addEventListener('click', () => location.reload());

// Host Btns
if($('updateTitleBtn')) $('updateTitleBtn').addEventListener('click', () => socket.emit('update-stream-title', $('streamTitleInput').value));
if($('updateSlugBtn')) $('updateSlugBtn').addEventListener('click', () => socket.emit('update-public-slug', $('slugInput').value));
if($('lockRoomBtn')) $('lockRoomBtn').addEventListener('click', () => socket.emit('lock-room', true));

// Global
window.kickUser = id => socket.emit('kick-user', id);
window.ringUser = id => socket.emit('ring-user', id);

// Tabs
const tabs = { chat:$('tabChatBtn'), files:$('tabFilesBtn'), users:$('tabUsersBtn') };
const conts = { chat:$('tabContentChat'), files:$('tabContentFiles'), users:$('tabContentUsers') };
function setTab(k) {
    Object.values(tabs).forEach(t=>t.classList.remove('active'));
    Object.values(conts).forEach(c=>c.classList.remove('active'));
    tabs[k].classList.add('active');
    conts[k].classList.add('active');
}
if(tabs.chat) Object.keys(tabs).forEach(k => tabs[k].addEventListener('click', () => setTab(k)));
