/**
 * REBEL API BRIDGE
 * Include this in your tool's index.html to control the stream.
 */
const RebelAPI = {
    // Updates a specific text field in the Smart Overlay
    setField: (key, value) => {
        window.parent.postMessage({ type: 'REBEL_CONTROL', action: 'setField', key, value }, '*');
    },

    // Switches the layout scene (e.g., "Full", "Compact", "Ticker")
    setScene: (sceneName) => {
        window.parent.postMessage({ type: 'REBEL_CONTROL', action: 'setScene', sceneName }, '*');
    },

    // Sends a system message or action notification to the public chat
    sendChat: (message) => {
        window.parent.postMessage({ type: 'REBEL_CHAT', text: message }, '*');
    }
};
