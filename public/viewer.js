const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });

const iceConfig = (typeof ICE_SERVERS !== 'undefined' && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc = null;           // Broadcast peer (host -> viewer)
let hostId = null;       // Socket id of current host for WebRTC replies
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random() * 1000);

// ==========================================
// 1. ARCADE RECEIVER (games/tools overlay)
// ==========================================
function setupReceiver(pcInstance) {
  pcInstance.ondatachannel = (e) => {
    if (e.channel.label !== "side-load-pipe") return;

    const chan = e.channel;
    let chunks = [];
    let total = 0;
    let received = 0;
    let meta = null;

    chan.onmessage = (evt) => {
      if (typeof evt.data === "string" && !meta) {
        try {
          const parsed = JSON.parse(evt.data);
          if (parsed && parsed.type === "meta") {
            meta = parsed;
            total = meta.size || 0;
            console.log("[Arcade] Receiving:", meta.name, "size:", total);
          }
        } catch (err) {
          console.warn("[Arcade] bad metadata", err);
        }
        return;
      }

      if (!meta) return;

      chunks.push(evt.data);
      received += evt.data.byteLength;

      if (total && received >= total) {
        const blob = new Blob(chunks, { type: meta.mime || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        addGameToChat(url, meta.name || "download.bin");

        chunks = [];
        received = 0;
        total = 0;
        meta = null;
        chan.close();
      }
    };
  };
}

function addGameToChat(url, name) {
  const log = $("chatLog");
  if (!log) return;

  const div = document.createElement("div");
  div.className = "chat-line system-msg";
  div.innerHTML = `
    <div style="
      background:rgba(74,243,163,0.12);
      border:1px solid #4af3a3;
      padding:10px;
      border-radius:8px;
      text-align:center;
      margin:8px 0;
      font-size:0.85rem;
    ">
      <div style="color:#4af3a3; font-weight:600; margin-bottom:6px;">
        TOOL RECEIVED: ${name}
      </div>
      <a href="${url}"
         download="${name}"
         style="
           background:#4af3a3;
           color:#000;
           padding:6px 14px;
           border-radius:999px;
           text-decoration:none;
           font-weight:600;
           font-size:0.8rem;
           display:inline-block;
         ">
         Download
      </a>
    </div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ==========================================
// 2. JOIN ROOM AS VIEWER + RECEIVE STREAM
// ==========================================
function initViewerJoin() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room") || "lobby";
  const nameParam = params.get("name");

  if (nameParam) {
    myName = nameParam;
  } else {
    const entered = prompt("Enter your display name:", myName);
    if (entered && entered.trim()) {
      myName = entered.trim().slice(0, 30);
    }
  }

  currentRoom = room;

  socket.connect();
  socket.emit("join-room", {
    room,
    name: myName,
    isViewer: true
  });
}

socket.on("connect", () => {
  const status = $("viewerStatus");
  if (status) {
    status.textContent = "CONNECTED";
  }
});

socket.on("disconnect", () => {
  const status = $("viewerStatus");
  if (status) {
    status.textContent = "OFFLINE";
  }
});

socket.on("room-error", (msg) => {
  alert(msg || "Room error");
  window.location.href = "index.html";
});

// Host → viewer broadcast WebRTC offer
socket.on("webrtc-offer", async ({ sdp, from }) => {
  try {
    hostId = from || hostId;

    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }

    pc = new RTCPeerConnection(iceConfig);
    setupReceiver(pc);

    pc.ontrack = (e) => {
      const vid = $("viewerVideo");
      if (!vid) return;
      if (vid.srcObject !== e.streams[0]) {
        vid.srcObject = e.streams[0];
        vid.play().catch(() => {});
      }
      const status = $("viewerStatus");
      if (status) {
        status.textContent = "LIVE";
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && hostId) {
        socket.emit("webrtc-ice-candidate", {
          targetId: hostId,
          candidate: e.candidate
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("webrtc-answer", {
      targetId: from,
      sdp: answer
    });
  } catch (err) {
    console.error("[Viewer] failed to handle offer", err);
  }
});

// Host → viewer ICE
socket.on("webrtc-ice-candidate", async ({ candidate }) => {
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error("[Viewer] ICE add failed", err);
  }
});

// ==========================================
// 3. "Bring On Stage" RING from Host
// ==========================================
function joinAsGuest() {
  if (!currentRoom) return;
  const base = window.location.pathname.replace("view.html", "index.html");
  const url = new URL(window.location.origin + base);
  url.searchParams.set("room", currentRoom);
  url.searchParams.set("name", myName);
  window.location.href = url.toString();
}

// Host uses ring-user → server emits ring-alert here
socket.on("ring-alert", ({ from }) => {
  const ok = confirm(
    `Host ${from} wants to bring you on stage.\n\n` +
    `If you accept, you'll join the main room with your camera.`
  );
  if (ok) {
    joinAsGuest();
  }
});

// ==========================================
// 4. CHAT & SYSTEM MESSAGES
// ==========================================
socket.on("public-chat", (d) => {
  const log = $("chatLog");
  if (!log) return;

  const div = document.createElement("div");
  div.className = "chat-line";

  const nameEl = document.createElement("strong");
  nameEl.textContent = d.name;

  const msgEl = document.createElement("span");
  msgEl.textContent = `: ${d.text}`;

  div.appendChild(nameEl);
  div.appendChild(msgEl);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
});

// Optional: show basic viewer/guest counts in status mirror
socket.on("room-update", ({ users, streamTitle }) => {
  const viewers = (users || []).filter(u => u.isViewer).length;
  const guests  = (users || []).filter(u => !u.isViewer).length;

  const mirror = $("viewerStatusMirror");
  if (mirror) {
    mirror.textContent = `${streamTitle || "Untitled Stream"} • 👁 ${viewers} • 👤 ${guests}`;
  }

  const status = $("viewerStatus");
  if (status && status.textContent === "OFFLINE") {
    status.textContent = "CONNECTED";
  }

  if (streamTitle) {
    document.title = `Rebel Stream - ${streamTitle}`;
  }
});

socket.on("kicked", () => {
  alert("You have been removed from this room by the host.");
  window.location.href = "index.html";
});

// ==========================================
// 5. VIEWER UI CONTROLS
// ==========================================
function sendChat() {
  const input = $("chatInput");
  if (!input || !currentRoom) return;
  const text = input.value.trim();
  if (!text) return;

  socket.emit("public-chat", {
    room: currentRoom,
    name: myName,
    text,
    fromViewer: true
  });

  input.value = "";
}

function wireUi() {
  const sendBtn = $("sendBtn");
  const chatInput = $("chatInput");
  if (sendBtn && chatInput) {
    sendBtn.onclick = sendChat;
    chatInput.onkeydown = (e) => {
      if (e.key === "Enter") sendChat();
    };
  }

  const emojiStrip = $("emojiStrip");
  if (emojiStrip && chatInput) {
    emojiStrip.onclick = (e) => {
      if (e.target.classList.contains("emoji")) {
        chatInput.value += e.target.textContent;
        chatInput.focus();
      }
    };
  }

  const requestBtn = $("requestCallBtn");
  if (requestBtn) {
    requestBtn.onclick = () => {
      socket.emit("request-to-call");
      requestBtn.textContent = "Request Sent ✋";
      requestBtn.disabled = true;
    };
  }

  const unmuteBtn = $("unmuteBtn");
  if (unmuteBtn) {
    unmuteBtn.onclick = () => {
      const v = $("viewerVideo");
      if (!v) return;
      const willUnmute = v.muted;
      v.muted = !v.muted;
      v.volume = v.muted ? 0.0 : 1.0;
      if (willUnmute) {
        v.play().catch(() => {});
        unmuteBtn.textContent = "🔊 Mute";
      } else {
        unmuteBtn.textContent = "🔇 Unmute";
      }
    };
  }

  const fsBtn = $("fullscreenBtn");
  if (fsBtn) {
    fsBtn.onclick = () => {
      const v = $("viewerVideo");
      if (!v) return;
      if (v.requestFullscreen) v.requestFullscreen();
      else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
      else if (v.msRequestFullscreen) v.msRequestFullscreen();
    };
  }

  const toggleChatBtn = $("toggleChatBtn");
  if (toggleChatBtn) {
    toggleChatBtn.onclick = () => {
      const box = $("chatBox");
      if (!box) return;
      box.classList.toggle("hidden");
    };
  }
}

window.addEventListener("load", () => {
  wireUi();
  initViewerJoin();
});
