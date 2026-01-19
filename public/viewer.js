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
 * This replaces the static SVG logic that was killing the tickers.
 */
function renderHTMLLayout(htmlString) {
    if (!htmlString) return;
    currentRawHTML = htmlString;
    
    let overlayLayer = document.getElementById('mixerOverlayLayer');
    if (!overlayLayer) {
        overlayLayer = document.createElement('div');
        overlayLayer.id = 'mixerOverlayLayer';
        // Position exactly over the video
        overlayLayer.style.cssText = "position:absolute; inset:0; z-index:10; pointer-events:none; overflow:hidden;"; 
        const videoLayer = document.querySelector('.video-layer');
        if (videoLayer) videoLayer.appendChild(overlayLayer);
    }

    // Scale the 1080p layout to fit the viewer's current video window
    const videoEl = document.getElementById('viewerVideo');
    const scale = videoEl ? videoEl.offsetWidth / 1920 : 1;

    overlayLayer.innerHTML = `
        <div style="width:1920px; height:1080px; transform-origin: top left; transform: scale(${scale});">
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
                    type: meta.mime || "application/octet-stream"
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
                        card.className = "download-card";
                        card.innerHTML = `
                            <p>Received file: <strong>${meta.name}</strong> (${Math.round(meta.size / 1024)} KB)</p>
                            <a href="${url}" download="${meta.name}" class="download-btn">Download</a>
                        `;
                        toolbox.appendChild(card);
                    }
                }

                console.log("[Arcade] Receive Complete.");
                chunks = [];
                meta = null;
                received = 0;
            }
        };
    };
}

// ======================================================
// 4. TOOL MESSAGE BRIDGE (REBEL API BRIDGE SUPPORT)
// ======================================================
window.addEventListener("message", (event) => {
    const data = event.data || {};
    const { type, action, key, value, sceneName, text } = data;

    if (type === 'REBEL_CONTROL') {
        if (action === 'setField' && key) {
            // For now, fields are driven via COMMANDs over public chat
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
    if (status) status.textContent = "DISCONNECTED";
});

socket.on("role", ({ isHost, streamTitle }) => {
    const titleEl = $("streamTitle");
    if (titleEl && streamTitle) titleEl.textContent = streamTitle;
});

socket.on("room-error", (msg) => {
    alert(msg || "Unable to join room.");
});

socket.on("room-joined", ({ room, name }) => {
    currentRoom = room;
    myName = name || myName;

    const status = $("viewerStatus");
    if (status) status.textContent = `IN ROOM: ${room}`;
});

socket.on("stream-start", async ({ hostSocketId }) => {
    hostId = hostSocketId;
    const v = $("viewerVideo");
    if (v) v.srcObject = null;

    if (pc) {
        pc.close();
        pc = null;
    }

    const pc1 = new RTCPeerConnection(iceConfig);
    pc = pc1;

    pc1.ontrack = (e) => {
        const [stream] = e.streams;
        const video = $("viewerVideo");
        if (video) {
            video.srcObject = stream;
            video.play().catch(() => {});
        }
        startStatsReporting(pc1);
    };

    pc1.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("webrtc-ice-candidate", {
                targetId: hostId,
                candidate: e.candidate
            });
        }
    };

    const offer = await pc1.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
    });
    await pc1.setLocalDescription(offer);

    socket.emit("webrtc-offer", {
        targetId: hostId,
        sdp: offer
    });
});

socket.on("webrtc-answer", async ({ sdp, from }) => {
    if (!pc || from !== hostId) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on("webrtc-ice-candidate", async ({ candidate, from }) => {
    if (!pc || from !== hostId) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.warn("Error adding ICE candidate", err);
    }
});

// ======================================================
// 6. PUBLIC / PRIVATE CHAT (Viewer Side)
// ======================================================
socket.on("public-chat", ({ name, text, ts, isOwner, fromViewer }) => {
    const log = $("chatLog");
    if (!log) return;

    const line = document.createElement("div");
    line.className = "chat-line";

    const when = new Date(ts);
    const timeStr = when.toLocaleTimeString();

    const safeName = (name || "Anon").slice(0, 30);
    const safeText = String(text || "").slice(0, 500);

    // COMMANDS reserved for overlays / tools
    if (safeText.startsWith("COMMAND:")) {
        // You can still keep command handling if needed
        return;
    }

    line.innerHTML = `
        <strong>${safeName}</strong> 
        <small>${timeStr}</small>: 
        ${safeText}
    `;

    if (isOwner) line.classList.add("owner");
    if (fromViewer) line.classList.add("viewer");

    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
});

socket.on("private-chat", ({ name, text, ts }) => {
    const log = $("privateChatLog");
    if (!log) return;

    const line = document.createElement("div");
    line.className = "chat-line private";

    const when = new Date(ts);
    const timeStr = when.toLocaleTimeString();

    const safeName = (name || "Anon").slice(0, 30);
    const safeText = String(text || "").slice(0, 500);

    line.innerHTML = `
        <strong>${safeName}</strong> 
        <small>${timeStr}</small>: 
        ${safeText}
    `;

    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
});

// ======================================================
// 7. CALL HANDLERS (Viewer “On Stage”)
// ======================================================
socket.on("incoming-call", async ({ from, name, offer }) => {
    const accept = confirm(`${name || "Host"} wants to bring you on stage. Accept?`);
    if (!accept) return;

    if (callPc) {
        callPc.close();
        callPc = null;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localCallStream = stream;

    const localPreview = $("localCallVideo");
    if (localPreview) {
        localPreview.srcObject = stream;
        localPreview.muted = true;
        localPreview.play().catch(() => {});
    }

    const remoteVideo = $("remoteCallVideo");
    if (!remoteVideo) return;

    const pc2 = new RTCPeerConnection(iceConfig);
    callPc = pc2;

    pc2.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("call-ice", {
                targetId: from,
                candidate: e.candidate
            });
        }
    };

    pc2.ontrack = (e) => {
        console.log("[Viewer] host call track", e.streams[0]);
        remoteVideo.srcObject = e.streams[0];
        remoteVideo.play().catch(() => {});
    };

    stream.getTracks().forEach(t => pc2.addTrack(t, stream));

    await pc2.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);

    socket.emit("call-answer", {
        targetId: from,
        answer
    });
});

socket.on("call-answer", async ({ from, answer }) => {
    if (!callPc || !answer) return;
    await callPc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on("call-ice", async ({ from, candidate }) => {
    if (!callPc || !candidate) return;
    try {
        await callPc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.warn("Error adding call ICE candidate", err);
    }
});

socket.on("call-end", ({ from }) => {
    if (callPc) {
        callPc.close();
        callPc = null;
    }
    const remoteVideo = $("remoteCallVideo");
    if (remoteVideo) remoteVideo.srcObject = null;
});

// ======================================================
// 8. UI BINDINGS
// ======================================================
document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room") || "default";
    const nameParam = params.get("name");
    if (nameParam) myName = nameParam.slice(0, 30);

    const nameInput = $("viewerName");
    if (nameInput) nameInput.value = myName;

    const joinBtn = $("joinBtn");
    if (joinBtn) {
        joinBtn.onclick = () => {
            const n = nameInput ? nameInput.value.trim() : myName;
            const finalName = n || myName;

            socket.connect();
            socket.emit("join-room", {
                room,
                name: finalName,
                isViewer: true
            });
        };
    }

    const chatInput = $("chatInput");
    const chatSend = $("chatSendBtn");
    if (chatInput && chatSend) {
        chatSend.onclick = () => {
            const text = chatInput.value.trim();
            if (!text) return;
            socket.emit("public-chat", {
                room: currentRoom,
                name: myName,
                text,
                fromViewer: true
            });
            chatInput.value = "";
        };

        chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                chatSend.click();
            }
        });
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

            unmuteBtn.textContent = willUnmute ? "Mute" : "Unmute";
            document.body.classList.toggle('unmuted', willUnmute);
        };
    }

    const fullscreenBtn = $("fullscreenBtn");
    if (fullscreenBtn) {
        fullscreenBtn.onclick = () => {
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

// ======================================================
// 9. OVERLAY SYNC LISTENER (NEW)
// ======================================================
socket.on('overlay-update', ({ html }) => {
    if (typeof renderHTMLLayout === "function" && html) {
        renderHTMLLayout(html);
    }
});
