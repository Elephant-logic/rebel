// ======================================================
// REBEL STREAM - ADVANCED VIEWER CLIENT
// - Handles host → viewer broadcast (WebRTC)
// - Chat overlay (with emojis)
// - ✋ Request to Join (call request)
// - Kicked handling
// - Unmute, fullscreen, toggle chat
// - Optional latency badge
// ======================================================

const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });

// ICE config (uses config/ice.js if provided)
const iceConfig = (typeof ICE_SERVERS !== "undefined" && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length)
    ? { iceServers: ICE_SERVERS }
    : { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// Broadcast stream PC (host → viewer)
let pc = null;
let hostId = null;
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random() * 1000);

// Optional 1:1 “on-stage” call
let callPc = null;
let localCallStream = null;

// ------------------------------------------------------
// Status helper (status pill + mirror)
// ------------------------------------------------------
function setStatus(text, isLive = false) {
    const pill = $("viewerStatus");
    const mirror = $("viewerStatusMirror");
    if (pill) {
        pill.textContent = text;
        if (isLive) pill.classList.add("live");
        else pill.classList.remove("live");
    }
    if (mirror) {
        mirror.textContent = text;
    }
    console.log("[ViewerStatus]", text);
}

// ------------------------------------------------------
// Arcade receiver (file/tool via side-load-pipe)
// ------------------------------------------------------
function setupReceiver(pcInstance) {
    pcInstance.ondatachannel = (e) => {
        if (e.channel.label !== "side-load-pipe") return;

        const chan = e.channel;
        let chunks = [];
        let meta = null;
        let received = 0;

        chan.onmessage = (evt) => {
            // First message is metadata JSON
            if (!meta && typeof evt.data === "string") {
                try {
                    const parsed = JSON.parse(evt.data);
                    if (parsed && parsed.type === "meta") {
                        meta = parsed;
                        received = 0;
                        chunks = [];
                        console.log("[Arcade] Receiving:", meta.name, meta.size);
                        return;
                    }
                } catch (err) {
                    console.warn("[Arcade] Bad meta", err);
                }
                return;
            }

            if (!meta) return;

            const chunk = evt.data;
            chunks.push(chunk);
            const size = chunk.byteLength || chunk.size || 0;
            received += size;

            if (received >= meta.size) {
                const blob = new Blob(chunks, {
                    type: meta.mime || "application/octet-stream",
                });
                const url = URL.createObjectURL(blob);

                const toolbox = $("toolboxContainer");
                if (toolbox) {
                    const card = document.createElement("div");
                    card.className = "toolbox-card";

                    const title = document.createElement("div");
                    title.className = "toolbox-title";
                    title.textContent = meta.name || "Download";

                    const actions = document.createElement("div");
                    actions.className = "toolbox-actions";

                    const link = document.createElement("a");
                    link.href = url;
                    link.download = meta.name || "download.bin";
                    link.className = "btn-ctrl";
                    link.textContent = "Download";

                    actions.appendChild(link);
                    card.appendChild(title);
                    card.appendChild(actions);
                    toolbox.appendChild(card);
                }

                console.log("[Arcade] Completed:", meta.name);
                meta = null;
                chunks = [];
                received = 0;
                chan.close();
            }
        };
    };
}

// ------------------------------------------------------
// WebRTC stream: host → viewer video
// ------------------------------------------------------
socket.on("connect", () => {
    setStatus("CONNECTED");
});

socket.on("disconnect", () => {
    setStatus("OFFLINE");
});

// Host sends us an SDP offer when stream is live
socket.on("webrtc-offer", async ({ sdp, from }) => {
    try {
        console.log("[Viewer] webrtc-offer from", from);
        hostId = from;
        setStatus("CONNECTING…");

        if (pc) {
            try { pc.close(); } catch (e) {}
            pc = null;
        }

        pc = new RTCPeerConnection(iceConfig);
        setupReceiver(pc);

        pc.ontrack = (e) => {
            console.log("[Viewer] ontrack stream", e.streams[0]);
            const v = $("viewerVideo");
            if (!v) return;
            if (v.srcObject !== e.streams[0]) {
                v.srcObject = e.streams[0];
                v.play().catch(() => {});
            }
            setStatus("LIVE", true);
        };

        pc.onicecandidate = (e) => {
            if (e.candidate && hostId) {
                socket.emit("webrtc-ice-candidate", {
                    targetId: hostId,
                    candidate: e.candidate,
                });
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("webrtc-answer", {
            targetId: hostId,
            sdp: answer,
        });

        console.log("[Viewer] Sent webrtc-answer to", hostId);
    } catch (err) {
        console.error("[Viewer] Error handling webrtc-offer", err);
        setStatus("ERROR");
    }
});

// ICE from host → viewer
socket.on("webrtc-ice-candidate", async ({ candidate }) => {
    if (!pc || !candidate) return;
    try {
        await pc.addIceCandidate(new RTCPeerConnection.iceCandidate(candidate));
    } catch (err) {
        // Some browsers still want RTCIceCandidate
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e2) {
            console.error("[Viewer] addIceCandidate failed", e2);
        }
    }
});

// ------------------------------------------------------
// Optional: viewer-side stats (latency badge)
// ------------------------------------------------------
setInterval(async () => {
    if (!pc || pc.connectionState !== "connected") return;

    try {
        const stats = await pc.getStats();
        let rttMs = null;

        stats.forEach((report) => {
            if (report.type === "remote-inbound-rtp" && report.kind === "video") {
                if (report.roundTripTime) {
                    rttMs = Math.round(report.roundTripTime * 1000);
                }
            }
        });

        const badge = $("latencyBadge");
        const mirror = $("viewerStatusMirror");
        if (badge && rttMs !== null) {
            badge.style.display = "inline-block";
            badge.textContent = `⏱️ ${rttMs}ms`;
        }
        if (mirror && rttMs !== null) {
            mirror.textContent = `${rttMs}ms`;
        }
    } catch (err) {
        // silent – stats failing isn’t fatal
    }
}, 2000);

// ------------------------------------------------------
// On-stage calls: host ↔ viewer (1:1)
// ------------------------------------------------------
async function ensureLocalCallStream() {
    if (
        localCallStream &&
        localCallStream.getTracks().some(t => t.readyState === "live")
    ) {
        return;
    }

    localCallStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
}

// Host has chosen us to join on-stage
socket.on("ring-alert", async ({ from, fromId }) => {
    console.log("[Viewer] ring-alert from", from, fromId);
    const ok = confirm(
        `Host ${from} wants to bring you on stage.\n\nAllow camera & mic?`
    );
    if (!ok) return;

    try {
        await ensureLocalCallStream();
        await startCallToHost(fromId);
    } catch (err) {
        console.error("[Viewer] stage call failed", err);
        alert("Could not access your camera/mic. Check permissions and try again.");
    }
});

async function startCallToHost(targetId) {
    if (!targetId) return;

    await ensureLocalCallStream();

    if (callPc) {
        try { callPc.close(); } catch (e) {}
        callPc = null;
    }

    const pc2 = new RTCPeerConnection(iceConfig);
    callPc = pc2;

    pc2.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("call-ice", {
                targetId,
                candidate: e.candidate,
            });
        }
    };

    pc2.ontrack = (e) => {
        console.log("[Viewer] host call track", e.streams[0]);
    };

    localCallStream.getTracks().forEach((t) =>
        pc2.addTrack(t, localCallStream)
    );

    const offer = await pc2.createOffer();
    await pc2.setLocalDescription(offer);

    socket.emit("call-offer", { targetId, offer });
    console.log("[Viewer] Sent call-offer to", targetId);
}

socket.on("call-answer", async ({ from, answer }) => {
    if (!callPc || !answer) return;
    try {
        await callPc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log("[Viewer] call-answer from", from);
    } catch (err) {
        console.error("[Viewer] remote answer failed", err);
    }
});

socket.on("call-ice", async ({ from, candidate }) => {
    if (!callPc || !candidate) return;
    try {
        await callPc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("[Viewer] call ICE failed", err);
    }
});

socket.on("call-end", ({ from }) => {
    console.log("[Viewer] call-end from", from);
    if (callPc) {
        try { callPc.close(); } catch (e) {}
        callPc = null;
    }
});

// ------------------------------------------------------
// Chat + kicked / room error
// ------------------------------------------------------
function appendChat(name, text) {
    const log = $("chatLog");
    if (!log) return;

    const div = document.createElement("div");
    div.className = "chat-line";

    const strong = document.createElement("strong");
    strong.textContent = name;

    const span = document.createElement("span");
    span.textContent = `: ${text}`;

    div.appendChild(strong);
    div.appendChild(span);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

socket.on("public-chat", (d) => {
    appendChat(d.name, d.text);
});

socket.on("kicked", () => {
    alert("You have been kicked from the room by the host.");
    window.location.href = "index.html";
});

socket.on("room-error", (err) => {
    alert(err || "Room error");
    window.location.href = "index.html";
});

// ------------------------------------------------------
// UI wiring: join, chat, hand, mute, fullscreen, etc.
// ------------------------------------------------------
function sendChat() {
    const input = $("chatInput");
    if (!input || !currentRoom) return;

    const text = input.value.trim();
    if (!text) return;

    socket.emit("public-chat", {
        room: currentRoom,
        name: myName,
        text,
        fromViewer: true,
    });

    input.value = "";
}

window.addEventListener("load", () => {
    // Room + name
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room") || "lobby";
    const nameParam = params.get("name");

    if (nameParam && nameParam.trim()) {
        myName = nameParam.trim().slice(0, 30);
    } else {
        const entered = prompt("Enter your display name:", myName);
        if (entered && entered.trim()) {
            myName = entered.trim().slice(0, 30);
        }
    }

    currentRoom = room;
    console.log("[Viewer] Joining room", room, "as", myName);

    socket.connect();
    socket.emit("join-room", {
        room,
        name: myName,
        isViewer: true,
    });

    setStatus("CONNECTING…");

    // Chat send
    const sendBtn = $("sendBtn");
    const chatInput = $("chatInput");
    if (sendBtn && chatInput) {
        sendBtn.onclick = sendChat;
        chatInput.onkeydown = (e) => {
            if (e.key === "Enter") sendChat();
        };
    }

    // Emoji bar
    const emojiStrip = $("emojiStrip");
    if (emojiStrip && chatInput) {
        emojiStrip.onclick = (e) => {
            if (e.target.classList.contains("emoji")) {
                chatInput.value += e.target.textContent;
                chatInput.focus();
            }
        };
    }

    // Request to join (hand)
    const requestBtn = $("requestCallBtn");
    if (requestBtn) {
        requestBtn.onclick = () => {
            console.log("[Viewer] Requesting to join call");
            socket.emit("request-to-call");
            appendChat("SYSTEM", "Call request sent to host.");
            document.body.classList.add("hand-active");
            requestBtn.textContent = "Request Sent ✋";
            requestBtn.disabled = true;
        };
    }

    // Unmute / mute
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
                unmuteBtn.classList.remove("pulse-primary");
            } else {
                unmuteBtn.textContent = "🔇 Unmute";
                unmuteBtn.classList.add("pulse-primary");
            }
        };
    }

    // Fullscreen
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

    // Toggle chat overlay
    const toggleChatBtn = $("toggleChatBtn");
    if (toggleChatBtn) {
        toggleChatBtn.onclick = () => {
            const box = $("chatBox");
            if (!box) return;
            box.classList.toggle("hidden");
        };
    }
});
