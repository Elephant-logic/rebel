// ========================================================
// REBEL OVERLAY PLUGIN (HOST SIDE) — MODE A
// Preview overlays only on the host's local preview
// (localContainer / localVideo), never over the whole UI.
// ========================================================

(function () {
    const $ = (id) => document.getElementById(id);

    // HTML input loader for static overlays
    const htmlInput = $("htmlOverlayInput");

    // current overlay HTML + state
    let currentHTML = "";
    let currentScene = "default";
    const fields = {};

    // ----------------------------------------------------
    // Resolve the proper container for the preview layer
    // ----------------------------------------------------
    function getPreviewHostContainer() {
        // Your app already uses this in app.js:
        //   const localContainer = $('localContainer');
        let container = $("localContainer");

        // Fallbacks in case markup ever changes
        if (!container) {
            container =
                document.querySelector(".local-video-container") ||
                document.querySelector(".video-wrapper") ||
                document.body;
        }

        // Make sure it can hold absolutely-positioned children
        if (container && getComputedStyle(container).position === "static") {
            container.style.position = "relative";
        }

        return container || document.body;
    }

    // ----------------------------------------------------
    // Create / fetch the overlay layer that sits on top of
    // the local preview ONLY (not the whole page).
    // ----------------------------------------------------
    function getPreviewLayer() {
        let layer = $("overlayPreviewLayer");
        if (!layer) {
            const host = getPreviewHostContainer();
            layer = document.createElement("div");
            layer.id = "overlayPreviewLayer";
            layer.style.cssText = `
                position:absolute;
                inset:0;
                z-index:5;
                pointer-events:none;
                overflow:hidden;
            `;
            host.appendChild(layer);
        }
        return layer;
    }

    // ----------------------------------------------------
    // Apply field placeholders + scene markers
    // ----------------------------------------------------
    function applyTemplate(html) {
        let out = html;

        // Fields: {{ fieldName }}
        for (const k in fields) {
            const v = fields[k];
            const re = new RegExp(`{{\\s*${k}\\s*}}`, "g");
            out = out.replace(re, v);
        }

        // Optional scene markers: @scene:Name
        out = out.replace(/@scene:([A-Za-z0-9_-]+)/g, (_, s) => {
            currentScene = s;
            return "";
        });

        return out;
    }

    // ----------------------------------------------------
    // Render local preview inside localContainer
    // ----------------------------------------------------
    function renderPreview() {
        if (!currentHTML) return;

        const preview = getPreviewLayer();
        const container = getPreviewHostContainer();
        const localVideo = $("localVideo");

        // Use the size of the video/container to scale from 1920x1080
        const baseWidth = 1920;
        const baseHeight = 1080;

        const w = (localVideo && localVideo.offsetWidth) || container.clientWidth || baseWidth;
        const scale = w / baseWidth;

        const processed = applyTemplate(currentHTML);

        preview.innerHTML = `
            <div style="
                width:${baseWidth}px;
                height:${baseHeight}px;
                transform-origin:top left;
                transform:scale(${scale});
            ">
                ${processed}
            </div>
        `;
    }

    // ----------------------------------------------------
    // Broadcast overlay to viewers via socket.io
    // ----------------------------------------------------
    function broadcast() {
        if (window.socket && window.currentRoom && currentHTML) {
            window.socket.emit("overlay-update", {
                room: window.currentRoom,
                html: applyTemplate(currentHTML)
            });
        }
    }

    // ----------------------------------------------------
    // STATIC HTML FILE LOADER (host side)
    // ----------------------------------------------------
    if (htmlInput) {
        htmlInput.onchange = (e) => {
            const f = e.target.files[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = (ev) => {
                currentHTML = String(ev.target.result || "");
                renderPreview();
                broadcast();
            };
            r.readAsText(f);
        };
    }

    // ----------------------------------------------------
    // REBEL API BRIDGE EVENT HANDLER
    // (Tools call RebelAPI.setField / setScene / exportHTML)
    // ----------------------------------------------------
    window.addEventListener("REBEL_OVERLAY_CONTROL", (ev) => {
        const { action, payload } = ev.detail || {};
        if (!action) return;

        switch (action) {
            case "set-field":
                if (payload && payload.key != null) {
                    fields[payload.key] = payload.value;
                    renderPreview();
                    broadcast();
                }
                break;

            case "set-scene":
                if (payload && payload.sceneName) {
                    currentScene = payload.sceneName;
                    renderPreview();
                    broadcast();
                }
                break;

            case "export-html":
                if (payload && typeof payload.html === "string") {
                    currentHTML = payload.html;
                    renderPreview();
                    broadcast();
                }
                break;
        }
    });

    // Keep overlay scaled correctly when host resizes
    window.addEventListener("resize", renderPreview);
})();
