const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });

// ICE config (uses ICE_SERVERS from ice.js if present, else Google STUN)
const iceConfig = (typeof ICE_SERVERS !== "undefined" && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length)
    ? { iceServers: ICE_SERVERS }
    : { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let pc = null;               // broadcast stream PC (host → viewer)
let hostId = null;           // socket id of the host sending us the stream
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random() * 1000);
let currentRawHTML = "";     // [PATCH] Stores latest overlay code for real-time sync

// separate PC for 1-to-1 “on-stage” call
let callPc = null;
let localCallStream = null;

// ======================================================
// 1. REAL-TIME HEALTH REPORTING (Professional Patch)
// ======================================================
let statsInterval = null;

function startStatsReporting(peer) {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
        if (!peer || peer.connectionState !== 'connected') return;

        const stats = await peer.getStats();
        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                // Calculate latency based on jitter buffer delay
                const latency = Math.round((report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000) || 0;
                
                // Update the Latency Badge in view.html
                const badge = $('latencyBadge');
                const mirror = $('viewerStatusMirror');
                if (badge) {
                    badge.innerHTML = `⏱️ ${latency}ms`;
                    badge.style.display = 'inline-block';
                    badge.style.color = latency > 200 ? '#ff4b6a' : '#9ba3c0';
                }
                if (mirror) mirror.innerHTML = `${latency}ms`;

                // Send latency back to the host via the server stats listener
                socket.emit('report-stats', { latency });
            }
        });
    }, 2000);
}

// ======================================================
// 2. [NEW PATCH] VIEWER OVERLAY RENDERER (ANIMATION FIX)
// ======================================================
/**
 * Renders HTML into a live DOM layer to allow CSS animations and JS timers.
 * FIXED: Uses Absolute positioning to float over the video without shifting it.
 */
function renderHTMLLayout(htmlString) {
    if (!htmlString) return;
    currentRawHTML = htmlString;
    
    let overlayLayer = document.getElementById('mixerOverlayLayer');
    if (!overlayLayer) {
        overlayLayer = document.createElement('div');
        overlayLayer.id = 'mixerOverlayLayer';
        // THE FIX: Position exactly over the video using absolute positioning
        overlayLayer.style.cssText = "position:absolute; inset:0; z-index:10; pointer-events:none; overflow:hidden;"; 
        const videoLayer = document.querySelector('.video-layer');
        if (videoLayer) {
            videoLayer.style.position = "relative"; // Anchor for absolute child
            videoLayer.appendChild(overlayLayer);
        }
    }

    // Scale the 1080p layout to fit the viewer's current video window
    const videoEl = document.getElementById('viewerVideo');
    const container = document.querySelector('.viewer-shell');
    // SCALING FIX: Use container width for better mobile fit
    const scale = container ? container.offsetWidth / 1920 : (videoEl ? videoEl.offsetWidth / 1920 : 1);

    overlayLayer.innerHTML = `
        <div style="width:1920px; height:1080px; transform-origin: top left; transform: scale(${scale}); pointer-events: none;">
            ${htmlString}
        </div>
    `;
}

// ======================================================
// 3. UPDATED ARCADE RECEIVER (Auto-Loader Patch)
// ======================================================
function setupReceiver(pcInstance) {
    pcInstance.ondatachannel = (e) => {
        if (e.channel.label !== "side-load-pipe") return;

        const chan = e.channel;
        let chunks = [];
        let meta = null;
        let received = 0;

        chan.onmessage = (evt) => {
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

            chunks.push(evt.data);
            received += evt.data.byteLength || evt.data.size || 0;

            if (received >= meta.size) {
                const blob = new Blob(chunks, {
                    type: meta.mime || "text/html"
                });
                const url = URL.createObjectURL(blob);

                const toolbox = $("toolboxContainer");
                if (toolbox) {
                    // AUTO-LOADER LOGIC: If file is an executable tool
                    if (meta.name.endsWith('.rebeltool') || meta.name.endsWith('.html')) {
                        toolbox.innerHTML = ''; // Clear existing tools
                        const frame = document.createElement("iframe");
                        frame.src = url;
                        // Security Sandbox: prevent top-level nav, allow scripts
                        frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
                        frame.style.cssText = "width:100%; height:100%; border:none; border-radius:12px; pointer-events:auto;";
                        toolbox.appendChild(frame);
                        console.log("[Arcade] Tool Mounted:", meta.name);
                    } else {
                        // Standard Download Card fallback
                        const card = document.createElement("div");
                        card.className = "toolbox-card";

                        const title = document.createElement("div");
                        title.className = "toolbox-title";
                        title.textContent = meta.name || "Tool";

                        const actions = document.createElement("div");
                        actions.className = "toolbox-actions";

                        const a = document.createElement("a");
                        a.href = url;
                        a.download = meta.name || "download.bin";
                        a.className = "btn-ctrl pulse-primary";
                        a.textContent = "Download";

                        actions.appendChild(a);
                        card.appendChild(title);
                        card.appendChild(actions);
                        toolbox.appendChild(card);
                    }
                }

                console.log("[Arcade] Complete:", meta.name);
                meta = null;
                chunks = [];
                received = 0;
                chan.close();
            }
        };
    };
}

// ======================================================
// 4. TOOLBOX API LISTENER (Bridge Hook)
// ======================================================
window.addEventListener("message", (event) => {
    const { type, action, key, value, sceneName, text } = event.data;

    // Handle Stream Controls from Tool
    if (type === 'REBEL_CONTROL') {
        // These call the Smart Overlay functions on the Host side via signaling
        if (action === 'setField') {
            socket.emit('public-chat', { 
                room: currentRoom, 
                name: "TOOL", 
                text: `COMMAND:setField:${key}:${value}` 
            });
        }
        if (action === 'setScene') {
            socket.emit('public-chat', { 
                room: currentRoom, 
                name: "TOOL", 
                text: `COMMAND:setScene:${sceneName}` 
            });
        }
    }

    // Handle Tool Chat Actions
    if (type === 'REBEL_CHAT' && text) {
        socket.emit('public-chat', {
            room: currentRoom,
            name: "TOOL",
            text: text,
            fromViewer: true
        });
    }
});

// ======================================================
// 5. STREAM CONNECTION (host → viewer video)
// ======================================================
socket.on("connect", () => {
    const status = $("viewerStatus");
    if (status) status.textContent = "CONNECTED";
});

socket.on("disconnect", () => {
    const status = $("viewerStatus");
    if (status) {
        status.textContent = "OFFLINE";
        status.classList.remove('live');
    }
});

// [PATCH] Receive direct HTML Overlay updates
socket.on('overlay-html', ({ html }) => {
    if (typeof renderHTMLLayout === 'function' && html) {
        renderHTMLLayout(html);
    }
});

// [PATCH] Standard overlay-update listener compatibility
socket.on("overlay-update", ({ html }) => {
    if (typeof renderHTMLLayout === "function" && html) {
        renderHTMLLayout(html);
    }
});

socket.on("webrtc-offer", async ({ sdp, from }) => {
    try {
        hostId = from;

        if (pc) {
            try { pc.close(); } catch (e) {}
            pc = null;
        }

        pc = new RTCPeerConnection(iceConfig);
        setupReceiver(pc);

        pc.ontrack = (e) => {
            const v = $("viewerVideo");
            if (!v) return;
            if (v.srcObject !== e.streams[0]) {
                v.srcObject = e.streams[0];
                v.play().catch(() => {});
            }
            const status = $("viewerStatus");
            if (status) {
                status.textContent = "LIVE";
                status.classList.add('live');
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
            targetId: hostId,
            sdp: answer
        });

        startStatsReporting(pc);

    } catch (err) {
        console.error("[Viewer] webrtc-offer failed", err);
    }
});

socket.on("webrtc-ice-candidate", async ({ candidate }) => {
    if (!pc || !candidate) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("[Viewer] addIceCandidate failed", err);
    }
});

// ======================================================
// 6. ON-STAGE CALL (host ↔ viewer 1-to-1 call)
// ======================================================
async function ensureLocalCallStream() {
    if (
        localCallStream &&
        localCallStream.getTracks().some(t => t.readyState === "live")
    ) {
        return;
    }

    localCallStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } }
    });

    const prev = $("selfCamPreview");
    if (prev) {
        prev.srcObject = localCallStream;
        prev.muted = true;
        prev.play().catch(() => {});
    }
}

socket.on("ring-alert", async ({ from, fromId }) => {
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
                targetId: targetId,
                candidate: e.candidate
            });
        }
    };

    pc2.ontrack = (e) => {
        console.log("[Viewer] host call track", e.streams[0]);
    };

    localCallStream.getTracks().forEach(t => pc2.addTrack(t, localCallStream));

    const offer = await pc2.createOffer();
    await pc2.setLocalDescription(offer);

    socket.emit("call-offer", {
        targetId: targetId,
        offer: offer
    });
}

socket.on("call-answer", async ({ from, answer }) => {
    if (!callPc || !answer) return;
    try {
        await callPc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
        console.error("[Viewer] remote answer failed", err);
    }
});

socket.on("call-ice", async ({ from, candidate }) => {
    if (!callPc || !candidate) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("[Viewer] call ICE failed", err);
    }
});

socket.on("call-end", ({ from }) => {
    if (callPc) {
        try { callPc.close(); } catch (e) {}
        callPc = null;
    }
});

// ======================================================
// 7. CHAT + SYSTEM COMMAND SYNC
// ======================================================
socket.on("public-chat", (d) => {
    // SYNC PATCH: Force re-render of local animated overlay
    if (d.text === 'COMMAND:update-overlay' && typeof renderHTMLLayout === 'function') {
        renderHTMLLayout(currentRawHTML);
    }
    
    // Process standard chat display
    appendChat(d.name, d.text);
});

function appendChat(name, text) {
    const log = $("chatLog");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "chat-line";
    div.innerHTML = `<strong>${name}</strong>: ${text}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

socket.on("kicked", () => {
    alert("You have been kicked from the room by the host.");
    window.location.href = "index.html";
});

socket.on("room-error", (err) => {
    alert(err || "Room error");
    window.location.href = "index.html";
});

// ======================================================
// 8. UI WIRING (join room, chat, mute, fullscreen, etc.)
// ======================================================
function sendChat() {
    const input = $("chatInput");
    if (!input || !currentRoom) return;

    const text = input.value.trim();
    if (!text) return;

    socket.emit("public-chat", {
        room: currentRoom,
        name: myName,
        text: text,
        fromViewer: true
    });

    input.value = "";
}

window.addEventListener("load", () => {
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

    const nameLabel = $("viewerNameLabel");
    if (nameLabel) nameLabel.textContent = myName;

    socket.connect();
    socket.emit("join-room", {
        room: room,
        name: myName,
        isViewer: true
    });

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
            document.body.classList.add('hand-active');
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
                unmuteBtn.classList.remove('pulse-primary');
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
});

// [PATCH] Final handler to rescale overlay on window resize
window.addEventListener('resize', () => {
    if (currentRawHTML) renderHTMLLayout(currentRawHTML);
});
