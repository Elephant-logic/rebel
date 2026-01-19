const RebelAPI = {
    setField: (key, value) => {
        window.parent.postMessage({ type: 'REBEL_CONTROL', action: 'field', key, value }, '*');
    },

    setScene: (scene) => {
        window.parent.postMessage({ type: 'REBEL_CONTROL', action: 'scene', scene }, '*');
    },

    send: (name, payload={}) => {
        window.parent.postMessage({ type: 'REBEL_CONTROL', action: name, payload }, '*');
    }
};
