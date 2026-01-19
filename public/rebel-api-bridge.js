/**
 * REBEL API BRIDGE
 * Include this in your tool's index.html to control the stream.
 *
 * Tools talk to the host studio via window.parent.postMessage.
 * The host listens for:
 *  - type: 'REBEL_CONTROL'       (setField / setScene)
 *  - type: 'REBEL_CHAT'          (chat messages)
 *  - type: 'REBEL_OVERLAY_HTML'  (optional: push full overlay HTML)
 *  - type: 'REBEL_EVENT'         (generic events)
 */

(function (global) {
    // Safely resolve the parent window (host studio)
    const parentWin = window.parent || window;

    function safePost(message) {
        try {
            parentWin.postMessage(message, '*');
        } catch (err) {
            console.error('[RebelAPI] postMessage failed:', err);
        }
    }

    const RebelAPI = {
        /**
         * Update a specific text/field in the Smart Overlay.
         * Host side: overlay-plugin.js listens for type:'REBEL_CONTROL', action:'setField'
         */
        setField: function (key, value) {
            if (!key) return;
            safePost({
                type: 'REBEL_CONTROL',
                action: 'setField',
                key: String(key),
                value: value
            });
        },

        /**
         * Switch the active overlay scene (e.g. "Full", "Compact", "Ticker").
         * Host side: overlay-plugin.js listens for type:'REBEL_CONTROL', action:'setScene'
         */
        setScene: function (sceneName) {
            if (!sceneName) return;
            safePost({
                type: 'REBEL_CONTROL',
                action: 'setScene',
                sceneName: String(sceneName)
            });
        },

        /**
         * Send a message into the public chat as this tool.
         * Host side: app.js / overlay system listens for type:'REBEL_CHAT'
         */
        sendChat: function (message) {
            if (!message) return;
            safePost({
                type: 'REBEL_CHAT',
                text: String(message)
            });
        },

        /**
         * OPTIONAL: Push a complete overlay HTML layout up to the host.
         * You can use this if your tool generates its own full overlay markup.
         * The host can listen for type:'REBEL_OVERLAY_HTML' and call renderHTMLLayout(html).
         */
        pushOverlayHTML: function (html) {
            if (!html) return;
            safePost({
                type: 'REBEL_OVERLAY_HTML',
                html: String(html)
            });
        },

        /**
         * Generic event channel for future extensions (games, votes, etc.).
         * Host receives: { type:'REBEL_EVENT', event:'name', payload:{...} }
         */
        emitEvent: function (eventName, payload) {
            if (!eventName) return;
            safePost({
                type: 'REBEL_EVENT',
                event: String(eventName),
                payload: payload
            });
        }
    };

    // Expose globally, but don’t overwrite if already present
    if (!global.RebelAPI) {
        global.RebelAPI = RebelAPI;
    }
})(window);
