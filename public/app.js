// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
const CHUNK_SIZE = 16 * 1024; 
const MAX_BUFFER = 256 * 1024; 

async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;
    const channel = pc.createDataChannel("side-load-pipe");
    channel.onopen = async () => {
        console.log(`[Arcade] Sending: ${file.name}`);
        channel.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));
        const buffer = await file.arrayBuffer();
        let offset = 0;
        const sendLoop = () => {
            if (channel.bufferedAmount > MAX_BUFFER) { setTimeout(sendLoop, 10); return; }
            if (channel.readyState !== 'open') return;
            channel.send(buffer.slice(offset, offset + CHUNK_SIZE));
            offset += CHUNK_SIZE;
            if (onProgress) onProgress(Math.min(100, Math.round((offset / file.size) * 100)));
            if (offset < buffer.byteLength) setTimeout(sendLoop, 0); 
            else setTimeout(() => channel.close(), 1000);
        };
        sendLoop();
    };
}

// ======================================================
// 2. MAIN SETUP
// ======================================================
console.log("Rebel Stream Host Loaded"); 
const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

let currentRoom = null;
let userName = 'User';
let myId = null;
let iAmHost = false;
let latestUserList = [];
let currentOwnerId = null;
let isPrivateMode = false;
let allowedGuests = [];

// Media & Mixer
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isStreaming = false; 
let activeToolboxFile = null;

let audioContext = null;
let audioDestination = null;
let canvas = document.createElement('canvas'); 
canvas.width = 1920; canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null; 
let mixerLayout = 'SOLO'; 
let activeGuestId = null; 

const viewerPeers = {}; 
const callPeers = {};   
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length) ? { iceServers: ICE_SERVERS } : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ======================================================
// 3. MIXER ENGINE
// ======================================================
function drawMixer() {
    if (!ctx) return;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const myVideo = $('localVideo');
    let guestVideo = null;
    if (activeGuestId) {
        const el = document.getElementById(`vid-${activeGuestId}`);
        if(el) guestVideo = el.querySelector('video');
    }

    if (mixerLayout === 'SOLO') {
        if (myVideo && myVideo.readyState === 4) ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
    } 
    else if (mixerLayout === 'GUEST') {
        if (guestVideo && guestVideo.readyState === 4) ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
        else { ctx.fillStyle = '#222'; ctx.font = "60px monospace"; ctx.textAlign="center"; ctx.fillStyle='#fff'; ctx.fillText("WAITING FOR GUEST", 960, 540); }
    }
    else if (mixerLayout === 'SPLIT') {
        const w = 960, h = 540, y = (1080 - h) / 2;
        if (myVideo && myVideo.readyState === 4) ctx.drawImage(myVideo, 0, y, w, h);
        if (guestVideo && guestVideo.readyState === 4) ctx.drawImage(guestVideo, 960, y, w, h);
        ctx.strokeStyle = '#333'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(960, 0); ctx.lineTo(960, 1080); ctx.stroke();
    }
    else if (mixerLayout === 'PIP') {
        if (myVideo && myVideo.readyState === 4) ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
        if (guestVideo && guestVideo.readyState === 4) {
            const w = 480, h = 270, x = 1410, y = 780; // Bottom Right
            ctx.strokeStyle = "#4af3a3"; ctx.lineWidth = 6; ctx.strokeRect(x, y, w, h); ctx.drawImage(guestVideo, x, y, w, h);
        }
    }
    requestAnimationFrame(drawMixer);
}
canvasStream = canvas.captureStream(30);
drawMixer();

window.setMixerLayout = (m) => { mixerLayout = m; document.querySelectorAll('.mixer-btn').forEach(b => b.classList.toggle('active', b.textContent.toUpperCase().includes(m) || (m==='PIP'&&b.textContent.includes('Overlay')))); };
window.setActiveGuest = (id) => { activeGuestId = id; alert("Guest Selected. Use Overlay/Split to view."); };

// ======================================================
// 4. DEVICE & MEDIA
// ======================================================
const settingsPanel = $('settingsPanel');
if($('settingsBtn')) $('settingsBtn').onclick = () => { settingsPanel.style.display = settingsPanel.style.display==='block'?'none':'block'; if(settingsPanel.style.display==='block') getDevices(); };
if($('closeSettingsBtn')) $('closeSettingsBtn').onclick = () => settingsPanel.style.display='none';

async function getDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        $('audioSource').innerHTML=''; $('videoSource').innerHTML=''; $('audioSource2').innerHTML='<option value="">-- None --</option>';
        devs.forEach(d => {
            const opt = document.createElement('option'); opt.value = d.deviceId; opt.text = d.label || d.kind;
            if(d.kind==='audioinput') { $('audioSource').appendChild(opt); $('audioSource2').appendChild(opt.cloneNode(true)); }
            if(d.kind==='videoinput') $('videoSource').appendChild(opt);
        });
    } catch(e){}
}
$('audioSource').onchange = startLocalMedia; $('audioSource2').onchange = startLocalMedia;
$('videoSource').onchange = startLocalMedia; $('videoQuality').onchange = startLocalMedia;

async function startLocalMedia() {
    if (isScreenSharing) return;
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    const q = $('videoQuality').value;
    const w = q==='max'?1920:(q==='low'?640:1280); const h = q==='max'?1080:(q==='low'?360:720);
    
    try {
        const ms = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: $('audioSource').value ? {exact:$('audioSource').value}:undefined },
            video: { deviceId: $('videoSource').value ? {exact:$('videoSource').value}:undefined, width:{ideal:w}, height:{ideal:h} }
        });
        
        let audioTrack = ms.getAudioTracks()[0];
        if($('audioSource2').value) {
            const s2 = await navigator.mediaDevices.getUserMedia({ audio: {deviceId: {exact:$('audioSource2').value}} });
            if(!audioContext) audioContext = new AudioContext();
            audioDestination = audioContext.createMediaStreamDestination();
            audioContext.createMediaStreamSource(ms).connect(audioDestination);
            audioContext.createMediaStreamSource(s2).connect(audioDestination);
            audioTrack = audioDestination.stream.getAudioTracks()[0];
        }

        localStream = new MediaStream([ms.getVideoTracks()[0], audioTrack]);
        $('localVideo').srcObject = localStream; $('localVideo').muted = true;

        // Feed Mixer to Viewers
        const mixV = canvasStream.getVideoTracks()[0];
        Object.values(viewerPeers).forEach(pc => {
            pc.getSenders().forEach(s => {
                if(s.track.kind === 'video') s.replaceTrack(mixV);
                if(s.track.kind === 'audio') s.replaceTrack(audioTrack);
            });
        });
        // Feed Raw to Guests
        Object.values(callPeers).forEach(p => {
            p.pc.getSenders().forEach(s => {
                if(s.track.kind === 'video') s.replaceTrack(ms.getVideoTracks()[0]);
                if(s.track.kind === 'audio') s.replaceTrack(audioTrack);
            });
        });
        
        $('hangupBtn').disabled = false;
        updateButtons();
    } catch(e) { console.error(e); alert("Camera Error"); }
}

function updateButtons() {
    if(!localStream) return;
    const v = localStream.getVideoTracks()[0]; const a = localStream.getAudioTracks()[0];
    $('toggleCamBtn').textContent = (v&&v.enabled)?'Camera On':'Camera Off'; $('toggleCamBtn').classList.toggle('danger', !(v&&v.enabled));
    $('toggleMicBtn').textContent = (a&&a.enabled)?'Mute':'Unmute'; $('toggleMicBtn').classList.toggle('danger', !(a&&a.enabled));
}
if($('toggleCamBtn')) $('toggleCamBtn').onclick = () => { if(localStream) localStream.getVideoTracks()[0].enabled = !localStream.getVideoTracks()[0].enabled; updateButtons(); };
if($('toggleMicBtn')) $('toggleMicBtn').onclick = () => { if(localStream) localStream.getAudioTracks()[0].enabled = !localStream.getAudioTracks()[0].enabled; updateButtons(); };

// --- SCREEN SHARING (FIXED) ---
if($('shareScreenBtn')) $('shareScreenBtn').onclick = async () => {
    if(isScreenSharing) {
        if(screenStream) screenStream.getTracks().forEach(t=>t.stop());
        isScreenSharing=false; screenStream=null; $('shareScreenBtn').textContent='Share Screen'; $('shareScreenBtn').classList.remove('danger'); startLocalMedia();
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
            isScreenSharing=true; $('shareScreenBtn').textContent='Stop Screen'; $('shareScreenBtn').classList.add('danger');
            $('localVideo').srcObject = screenStream; 
            
            // *** FIX: Send Screen to All Peers (Guests) ***
            const screenTrack = screenStream.getVideoTracks()[0];
            const screenAudio = screenStream.getAudioTracks()[0]; // Capture system audio if present

            Object.values(callPeers).forEach(p => {
                p.pc.getSenders().forEach(s => {
                    if(s.track.kind === 'video') s.replaceTrack(screenTrack);
                    if(screenAudio && s.track.kind === 'audio') s.replaceTrack(screenAudio);
                });
            });

            screenStream.getVideoTracks()[0].onended = () => $('shareScreenBtn').click();
        } catch(e){}
    }
};

// ======================================================
// 5. CONNECTIONS & BROADCAST
// ======================================================
if($('startStreamBtn')) $('startStreamBtn').onclick = () => {
    if(!currentRoom || !iAmHost) return alert("Host Only");
    if(isStreaming) {
        isStreaming=false; $('startStreamBtn').textContent="Start Stream"; $('startStreamBtn').classList.remove('danger');
        Object.values(viewerPeers).forEach(pc => pc.close());
    } else {
        startLocalMedia().then(() => {
            isStreaming=true; $('startStreamBtn').textContent="Stop Stream"; $('startStreamBtn').classList.add('danger');
            latestUserList.forEach(u => { if(u.id!==myId) connectViewer(u.id); });
        });
    }
};

async function connectViewer(targetId) {
    if(viewerPeers[targetId]) return;
    const pc = new RTCPeerConnection(iceConfig);
    viewerPeers[targetId] = pc;
    
    // FORCE DATA CHANNEL FOR ARCADE
    pc.createDataChannel("control"); 

    pc.onicecandidate = e => { if(e.candidate) socket.emit('webrtc-ice-candidate', {targetId, candidate:e.candidate}); };
    
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream));
    if(localStream) { const a = localStream.getAudioTracks()[0]; if(a) pc.addTrack(a, canvasStream); }
    
    if(activeToolboxFile) pushFileToPeer(pc, activeToolboxFile);
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', {targetId, sdp:offer});
}

// ARCADE
if($('arcadeInput')) $('arcadeInput').onchange = () => {
    const f = $('arcadeInput').files[0]; if(!f) return;
    activeToolboxFile = f; $('arcadeStatus').textContent = `Loaded: ${f.name}`;
    
    let btn = $('resendBtn');
    if(!btn) {
        btn=document.createElement('button'); btn.id='resendBtn'; btn.textContent='Force Resend'; btn.className='btn small secondary full-width'; 
        btn.onclick = () => { Object.values(viewerPeers).forEach(p => pushFileToPeer(p, activeToolboxFile)); alert("Resent."); };
        $('arcadeStatus').parentNode.appendChild(btn);
    }
    Object.values(viewerPeers).forEach(p => pushFileToPeer(p, f));
};

// ... Standard Socket/UI Logic ...
socket.on('connect', ()=>{ $('signalStatus').className='status-dot status-connected'; $('signalStatus').textContent='Connected'; myId=socket.id; });
$('joinBtn').onclick = () => { currentRoom=$('roomInput').value; userName=$('nameInput').value||'Host'; socket.connect(); socket.emit('join-room',{room:currentRoom, name:userName}); updateLink(currentRoom); startLocalMedia(); };
function updateLink(r) { $('streamLinkInput').value = window.location.href.replace('index.html','')+'view.html?room='+encodeURIComponent(r); }

socket.on('user-joined', ({id}) => { if(iAmHost && isStreaming) connectViewer(id); });
socket.on('webrtc-answer', async ({from, sdp}) => { if(viewerPeers[from]) await viewerPeers[from].setRemoteDescription(new RTCSessionDescription(sdp)); });
socket.on('webrtc-ice-candidate', async ({from, candidate}) => { if(viewerPeers[from]) await viewerPeers[from].addIceCandidate(new RTCIceCandidate(candidate)); });

// P2P Calls
socket.on('ring-alert', async ({from, fromId}) => { if(confirm("Call from "+from+"?")) callPeer(fromId); });
async function callPeer(id) {
    if(!localStream) await startLocalMedia();
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[id] = {pc, name:"Peer"};
    pc.onicecandidate = e => { if(e.candidate) socket.emit('call-ice', {targetId:id, candidate:e.candidate}); };
    pc.ontrack = e => addRemoteVideo(id, e.streams[0]);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.emit('call-offer', {targetId:id, offer});
    renderUserList();
}
socket.on('incoming-call', async ({from, offer}) => {
    if(!localStream) await startLocalMedia();
    const pc = new RTCPeerConnection(iceConfig);
    callPeers[from] = {pc, name:"Peer"};
    pc.onicecandidate = e => { if(e.candidate) socket.emit('call-ice', {targetId:from, candidate:e.candidate}); };
    pc.ontrack = e => addRemoteVideo(from, e.streams[0]);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    socket.emit('call-answer', {targetId:from, answer:ans});
    renderUserList();
});
socket.on('call-answer', async ({from, answer}) => { if(callPeers[from]) await callPeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer)); });
socket.on('call-ice', async ({from, candidate}) => { if(callPeers[from]) await callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)); });
socket.on('call-end', ({from}) => endPeerCall(from));
function endPeerCall(id) { if(callPeers[id]) callPeers[id].pc.close(); delete callPeers[id]; removeRemoteVideo(id); renderUserList(); }

// UI Helpers
const tabs={stream:$('tabStreamChat'), room:$('tabRoomChat'), files:$('tabFiles'), users:$('tabUsers')};
const conts={stream:$('contentStreamChat'), room:$('contentRoomChat'), files:$('contentFiles'), users:$('contentUsers')};
Object.keys(tabs).forEach(k => tabs[k].onclick = () => { Object.values(tabs).forEach(t=>t.classList.remove('active')); Object.values(conts).forEach(c=>c.classList.remove('active')); tabs[k].classList.add('active'); conts[k].classList.add('active'); });

function renderUserList() {
    $('userList').innerHTML=''; latestUserList.forEach(u => {
        if(u.id===myId) return;
        const d=document.createElement('div'); d.className='user-item'; d.innerHTML=`<span>${u.id===currentOwnerId?'👑 ':''}${u.name}</span>`;
        const act=document.createElement('div'); act.className='user-actions';
        const cBtn=document.createElement('button'); cBtn.className='action-btn'; cBtn.textContent=callPeers[u.id]?'End Call':'Call'; cBtn.onclick=()=>callPeers[u.id]?endPeerCall(u.id):callPeer(u.id);
        act.appendChild(cBtn);
        if(callPeers[u.id] && iAmHost) { const sBtn=document.createElement('button'); sBtn.className='action-btn'; sBtn.textContent='Select'; sBtn.onclick=()=>window.setActiveGuest(u.id); act.appendChild(sBtn); }
        if(iAmHost) { const kBtn=document.createElement('button'); kBtn.className='action-btn kick'; kBtn.textContent='Kick'; kBtn.onclick=()=>socket.emit('kick-user', u.id); act.appendChild(kBtn); }
        d.appendChild(act); $('userList').appendChild(d);
    });
}
socket.on('room-update', d => { latestUserList=d.users; currentOwnerId=d.ownerId; renderUserList(); });
socket.on('role', d => { iAmHost=d.isHost; $('hostControls').style.display=iAmHost?'block':'none'; renderUserList(); });

function addRemoteVideo(id, stream) {
    let d = document.getElementById(`vid-${id}`);
    if (!d) { d = document.createElement('div'); d.className = 'video-container'; d.id = `vid-${id}`; d.innerHTML=`<video autoplay playsinline></video><h2>Guest</h2>`; $('videoGrid').appendChild(d); }
    d.querySelector('video').srcObject = stream;
}
function removeRemoteVideo(id) { const e=$(`vid-${id}`); if(e) e.remove(); }

// Chat & Files
function appendChat(l,n,t,ts) { const d=document.createElement('div'); d.className='chat-line'; d.innerHTML=`<b>${n}</b>: ${t}`; l.appendChild(d); l.scrollTop=l.scrollHeight; }
const send = (type) => { const i=$(type==='public'?'inputPublic':'inputPrivate'); socket.emit(type+'-chat', {room:currentRoom, name:userName, text:i.value}); i.value=''; };
$('btnSendPublic').onclick=()=>send('public'); $('btnSendPrivate').onclick=()=>send('private');
socket.on('public-chat', d=>appendChat($('chatLogPublic'),d.name,d.text,d.ts));
socket.on('private-chat', d=>appendChat($('chatLogPrivate'),d.name,d.text,d.ts));

if($('emojiStripPublic')) $('emojiStripPublic').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPublic').value += e.target.textContent; };
if($('emojiStripPrivate')) $('emojiStripPrivate').onclick = e => { if(e.target.classList.contains('emoji')) $('inputPrivate').value += e.target.textContent; };

if($('openStreamBtn')) $('openStreamBtn').onclick = () => window.open(window.location.href.replace('index.html','view.html?room='+encodeURIComponent(currentRoom)), '_blank');
