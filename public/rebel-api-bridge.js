// ========================================================
// REBEL API BRIDGE  —  HOST OVERLAY CONTROL API
// ========================================================
// Tools (HTML overlays / Web plugins) include this file to
// control the broadcast overlay layer in Rebel Stream.
//
// Example usage from overlay code:
//    RebelAPI.setField("song", "Elysium");
//    RebelAPI.setScene("Ticker");
// ========================================================

(function() {
    if (!window.RebelAPI) window.RebelAPI = {};

    // Send updates to overlay plugin (host side)
    function sendLocal(action, payload) {
        window.dispatchEvent(new CustomEvent("REBEL_OVERLAY_CONTROL", {
            detail: { action, payload }
        }));
    }

    // Send overlay updates to server → viewers
    function sendBroadcast(html) {
        if (window.socket && window.currentRoom) {
            window.socket.emit("overlay-update", {
                room: window.currentRoom,
                html
            });
        }
    }

    RebelAPI.setField = function(key, value) {
        sendLocal("set-field", { key, value });
    };

    RebelAPI.setScene = function(sceneName) {
        sendLocal("set-scene", { sceneName });
    };

    RebelAPI.exportHTML = function(html) {
        sendLocal("export-html", { html });
        sendBroadcast(html);
    };

})();
