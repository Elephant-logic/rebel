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

// last known users list from the server
let lastUserList = [];

// Track call state (host vs viewer)
let isOnStage = false;

// Utility: parse query string
function getQueryParam(key) {
    const params = new URLSearchParams(window.location.search);
    return params.get(key);
}

// ======================================================
// 1. JOIN ROOM + SIGNAL SETUP
// ======================================================
function joinRoom(room, name) {
    if (!room) return;

    currentRoom = room;
    myName = name || myName;

    // Connect socket
    socket.connect();

    socket.emit("join-room", {
        room,
        name: myName,
        isViewer: true
    });
}

// When socket connects, update status indicator
socket.on("connect", () => {
    const el = $("signalStatus");
    if (el) {
        el.className = "status-dot status-connected";
        el.textContent = "Connected";
    }
});

socket.on("disconnect", () => {
    const el = $("signalStatus");
    if (el) {
        el.className = "status-dot status-disconnected";
        el.textContent = "Disconnected";
    }
});

// Server tells us who the host is and if stream is live
socket.on("room-update", (payload) => {
    lastUserList = payload.users || [];

    const hostUser = lastUserList.find(u => !u.isViewer && u.isHost);
    hostId = hostUser ? hostUser.id : null;

    const titleEl = $("streamTitle");
    if (titleEl && payload.streamTitle) {
        titleEl.textContent = payload.streamTitle;
    }

    const countEl = $("viewerCount");
    if (countEl) {
        const viewers = lastUserList.filter(u => u.isViewer).length;
        countEl.textContent = viewers;
    }

    // If there's a host and we haven't got a PC, request a stream
    if (hostId && !pc && payload.streamLive) {
        requestStreamFromHost();
    }
});

// Host will send this to tell us that stream is starting or stopping
socket.on("host-stream-state", ({ live }) => {
    if (live) {
        requestStreamFromHost();
    } else {
        destroyViewerPc();
        const v = $("viewerVideo");
        if (v) v.srcObject = null;
        const overlay = $("mixerOverlayLayer");
        if (overlay) overlay.innerHTML = "";
    }
});

// ======================================================
// 2. VIEWER WEBRTC HANDSHAKE
// ======================================================
function requestStreamFromHost() {
    if (!hostId || pc) return;

    pc = new RTCPeerConnection(iceConfig);

    pc.ontrack = (evt) => {
        const v = $("viewerVideo");
        if (v) {
            v.srcObject = evt.streams[0];
            v.play().catch(() => {});
        }
    };

    pc.onicecandidate = (evt) => {
        if (evt.candidate) {
            socket.emit("webrtc-ice-candidate", {
                targetId: hostId,
                candidate: evt.candidate
            });
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
            destroyViewerPc();
        }
    };

    // viewer creates offer
    pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", {
            targetId: hostId,
            sdp: offer
        });
    }).catch(console.error);
}

function destroyViewerPc() {
    if (pc) {
        try { pc.close(); } catch (e) {}
        pc = null;
    }
}

// Host replies with answer
socket.on("webrtc-answer", ({ from, sdp }) => {
    if (!pc || from !== hostId) return;
    pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(console.error);
});

// ICE from host
socket.on("webrtc-ice-candidate", ({ from, candidate }) => {
    if (!pc || from !== hostId || !candidate) return;
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
});

// ======================================================
// 2. SMART OVERLAY RENDERER (Viewer-side)
// ======================================================
/**
 * Renders the overlay into #mixerOverlayLayer in the viewer DOM.
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
// 2b. OVERLAY UPDATES FROM HOST (Smart Overlay Channel)
// ======================================================
socket.on("overlay-update", ({ html }) => {
    if (typeof html === "string" && html.trim()) {
        currentRawHTML = html;
        renderHTMLLayout(html);
    }
});

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
            if (!meta) {
                try {
                    meta = JSON.parse(evt.data);
                    if (meta.type !== "meta") {
                        meta = null;
                    } else {
                        return;
                    }
                } catch {
                    meta = null;
                }
            }

            if (!meta) return;

            const chunk = evt.data;
            if (typeof chunk === "string") return;

            chunks.push(chunk);
            received += chunk.byteLength;

            if (received >= meta.size) {
                const blob = new Blob(chunks, { type: meta.mime || "application/octet-stream" });

                // Decide how to handle based on mime
                if ((meta.mime && meta.mime.includes("html")) || meta.name.endsWith(".html") || meta.name.endsWith(".rebeltool")) {
                    // Load code into live overlay renderer
                    const reader = new FileReader();
                    reader.onload = () => {
                        const html = reader.result;
                        currentRawHTML = html;
                        renderHTMLLayout(html);
                    };
                    reader.readAsText(blob);
                } else {
                    // Fallback: simple download
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = meta.name || "download.bin";
                    a.style.display = "none";
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        URL.revokeObjectURL(a.href);
                        a.remove();
                    }, 5000);
                }

                // Reset
                chunks = [];
                meta = null;
                received = 0;
            }
        };
    };
}

// This will be called once WebRTC PC is created
function attachArcade(pcInstance) {
    setupReceiver(pcInstance);
}

// Hook into viewer PC creation
(function patchForArcade() {
    const originalRequest = requestStreamFromHost;
    requestStreamFromHost = function() {
        if (pc) return;
        originalRequest();
        // when pc is created:
        setTimeout(() => {
            if (pc) attachArcade(pc);
        }, 1000);
    };
})();

// ======================================================
// 4. ON-STAGE CALL WEBRTC (Viewer <-> Host)
// ======================================================
function requestOnStage() {
    if (!currentRoom) return;

    socket.emit("call-request", {
        room: currentRoom
    });

    const status = $("callStatus");
    if (status) {
        status.textContent = "Requested to join the stream…";
    }
}

// Host decides to ring us
socket.on("ring-alert", async ({ from, fromId }) => {
    // for viewer, if host rings, auto-accept
    if (fromId !== hostId) return;

    try {
        await startOnStageCall();
    } catch (err) {
        console.error("Error starting call:", err);
        alert("Could not start call – check camera/mic permissions.");
    }
});

async function startOnStageCall() {
    if (callPc) return;
    isOnStage = true;

    callPc = new RTCPeerConnection(iceConfig);

    // remote track from host (or mixed canvas)
    callPc.ontrack = (evt) => {
        const v = $("stageVideo");
        if (v) {
            v.srcObject = evt.streams[0];
            v.play().catch(() => {});
        }
    };

    callPc.onicecandidate = (evt) => {
        if (evt.candidate) {
            socket.emit("call-ice", {
                candidate: evt.candidate
            });
        }
    };

    callPc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(callPc.connectionState)) {
            endOnStageCall(true);
        }
    };

    // viewer uses mic + camera for the call
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
    });

    stream.getTracks().forEach(t => callPc.addTrack(t, stream));

    const vLocal = $("localStageVideo");
    if (vLocal) {
        vLocal.srcObject = stream;
        vLocal.muted = true;
        vLocal.play().catch(() => {});
    }

    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);

    socket.emit("call-offer", {
        offer
    });

    const status = $("callStatus");
    if (status) {
        status.textContent = "On Stage";
    }
}

function endOnStageCall(isRemote) {
    isOnStage = false;

    if (callPc) {
        try { callPc.close(); } catch (e) {}
        callPc = null;
    }

    const v = $("stageVideo");
    if (v) v.srcObject = null;
    const vLocal = $("localStageVideo");
    if (vLocal) vLocal.srcObject = null;

    if (!isRemote) {
        socket.emit("call-end");
    }

    const status = $("callStatus");
    if (status) status.textContent = "Not on Stage";
}

// Call answer from host
socket.on("call-answer", async ({ answer }) => {
    if (!callPc) return;
    await callPc.setRemoteDescription(new RTCSessionDescription(answer));
});

// Call ice candidate from host
socket.on("call-ice", ({ candidate }) => {
    if (!callPc || !candidate) return;
    callPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
});

// Host ends the call
socket.on("call-end", () => {
    endOnStageCall(true);
});

// ======================================================
// 7. CHAT + SYSTEM COMMAND SYNC
// ======================================================
socket.on("public-chat", (d) => {
    const name = d && d.name ? d.name : "SYSTEM";
    const text = typeof d.text === "string" ? d.text : "";

    // Hide internal COMMAND messages from viewer chat
    if (text.startsWith("COMMAND:")) {
        if (text === "COMMAND:update-overlay" && currentRawHTML) {
            // Backwards compatibility: older host builds
            renderHTMLLayout(currentRawHTML);
        }
        return;
    }

    appendChat(name, text);
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
function initUi() {
    const roomFromQuery = getQueryParam("room");
    const roomInput = $("roomInput");
    if (roomInput && roomFromQuery) {
        roomInput.value = roomFromQuery;
    }

    const nameInput = $("nameInput");
    if (nameInput) {
        nameInput.value = myName;
    }

    const joinBtn = $("joinBtn");
    if (joinBtn) {
        joinBtn.onclick = () => {
            const r = roomInput ? roomInput.value.trim() : "";
            const n = nameInput ? nameInput.value.trim() : myName;
            if (!r) {
                alert("Room is required");
                return;
            }
            joinRoom(r, n);
            joinBtn.disabled = true;
        };
    }

    const requestStageBtn = $("requestStageBtn");
    if (requestStageBtn) {
        requestStageBtn.onclick = () => {
            requestOnStage();
        };
    }

    const endStageBtn = $("endStageBtn");
    if (endStageBtn) {
        endStageBtn.onclick = () => {
            endOnStageCall(false);
        };
    }

    const chatInput = $("chatInput");
    const chatSend = $("chatSendBtn");
    if (chatSend && chatInput) {
        const send = () => {
            const text = chatInput.value.trim();
            if (!text || !currentRoom) return;
            socket.emit("public-chat", {
                room: currentRoom,
                name: myName,
                text
            });
            chatInput.value = "";
        };
        chatSend.onclick = send;
        chatInput.onkeydown = (e) => {
            if (e.key === "Enter") send();
        };
    }

    const muteBtn = $("muteBtn");
    if (muteBtn) {
        muteBtn.onclick = () => {
            const v = $("viewerVideo");
            if (!v) return;
            v.muted = !v.muted;
            muteBtn.textContent = v.muted ? "Unmute" : "Mute";
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

// Init on DOM ready
document.addEventListener("DOMContentLoaded", initUi);
