// ========================================================
// REBEL OVERLAY PLUGIN (HOST SIDE) — FIXED VERSION
// Mode: A (Preview over camera feed only)
// ========================================================

(function() {
    const $ = (id) => document.getElementById(id);

    // HTML input loader for static overlays
    const htmlInput = $("htmlOverlayInput");

    // target: local preview on host camera
    function getPreviewLayer() {
        let layer = $("overlayPreviewLayer");
        if (!layer) {
            layer = document.createElement("div");
            layer.id = "overlayPreviewLayer";
            layer.style.cssText = `
                position:absolute;
                inset:0;
                z-index:9999;
                pointer-events:none;
                overflow:hidden;
            `;
            const videoLayer = document.querySelector(".video-layer") || document.body;
            videoLayer.appendChild(layer);
        }
        return layer;
    }

    // current overlay HTML
    let currentHTML = "";
    let currentScene = "default";
    const fields = {};

    // apply field + scene cues to overlay HTML
    function applyTemplate(html) {
        let out = html;

        // field placeholders: {{field}}
        for (const k in fields) {
            const v = fields[k];
            const re = new RegExp(`{{\\s*${k}\\s*}}`, "g");
            out = out.replace(re, v);
        }

        // optional scene markers
        out = out.replace(/@scene:([A-Za-z0-9_-]+)/g, (_, s) => {
            currentScene = s;
            return "";
        });

        return out;
    }

    // render local preview
    function renderPreview() {
        if (!currentHTML) return;
        const preview = getPreviewLayer();
        const video = $("localVideo");

        const scale = video ? (video.offsetWidth / 1920) : 1;
        const processed = applyTemplate(currentHTML);

        preview.innerHTML = `
            <div style="width:1920px; height:1080px;
                        transform-origin:top left;
                        transform:scale(${scale});">
                ${processed}
            </div>
        `;
    }

    // broadcast overlay to viewers
    function broadcast() {
        if (window.socket && window.currentRoom && currentHTML) {
            window.socket.emit("overlay-update", {
                room: window.currentRoom,
                html: applyTemplate(currentHTML)
            });
        }
    }

    // ========================
    // HANDLER: File input load
    // ========================
    if (htmlInput) {
        htmlInput.onchange = (e) => {
            const f = e.target.files[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = (ev) => {
                currentHTML = String(ev.target.result);
                renderPreview();
                broadcast();
            };
            r.readAsText(f);
        };
    }

    // ========================
    // HANDLER: RebelAPI controls
    // ========================
    window.addEventListener("REBEL_OVERLAY_CONTROL", (ev) => {
        const { action, payload } = ev.detail || {};
        if (!action) return;

        switch(action) {
            case "set-field":
                fields[payload.key] = payload.value;
                renderPreview();
                broadcast();
                break;

            case "set-scene":
                currentScene = payload.sceneName;
                renderPreview();
                broadcast();
                break;

            case "export-html":
                currentHTML = payload.html;
                renderPreview();
                broadcast();
                break;
        }
    });

    // ========================
    // AUTO-SCALE ON RESIZE
    // ========================
    window.addEventListener("resize", renderPreview);
})();
