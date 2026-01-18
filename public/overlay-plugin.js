/**
 * REBEL SMART LOADER PLUGIN
 * Integrates with existing app.js renderHTMLLayout without modifying core logic.
 */
(function() {
    const $ = id => document.getElementById(id);
    
    // Globals for plugin state
    window.currentRawHTML = "";
    window.activeScene = "Full";

    // 1. Identify Existing Hooks
    const htmlInput = $('htmlOverlayInput');
    const originalRender = window.renderHTMLLayout; // Capture original app.js function

    if (!htmlInput || typeof originalRender !== 'function') {
        console.warn("Smart Overlay Plugin: Missing required app.js hooks.");
        return;
    }

    // 2. Intercept Overlay File Selection
    htmlInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            window.currentRawHTML = event.target.result;
            
            // Parse for Smart Config block
            const parser = new DOMParser();
            const doc = parser.parseFromString(window.currentRawHTML, 'text/html');
            const configScript = doc.getElementById('overlay-config');

            if (configScript) {
                try {
                    const config = JSON.parse(configScript.textContent);
                    setupDashboard(config);
                    $('liveEditor').style.display = 'block';
                } catch (err) {
                    console.error("Overlay Plugin: JSON Parse failed.", err);
                    $('liveEditor').style.display = 'none';
                }
            } else {
                $('liveEditor').style.display = 'none';
            }

            // Trigger the initial render
            window.renderHTMLLayout(window.currentRawHTML);
        };
        reader.readAsText(file);
    });

    // 3. Build the Dynamic Dashboard UI
    function setupDashboard(config) {
        const fieldContainer = $('dynamicFields');
        const sceneGroup = $('sceneBtnGroup');
        const sceneSwitcher = $('sceneSwitcher');

        fieldContainer.innerHTML = '';
        sceneGroup.innerHTML = '';

        // Handle Scenes
        if (config.scenes && config.scenes.length > 0) {
            sceneSwitcher.style.display = 'block';
            config.scenes.forEach(scene => {
                const btn = document.createElement('button');
                btn.className = 'mixer-btn';
                btn.textContent = scene;
                if (scene === window.activeScene) btn.classList.add('active');
                
                btn.onclick = () => {
                    window.setOverlayScene(scene);
                    document.querySelectorAll('#sceneBtnGroup .mixer-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                };
                sceneGroup.appendChild(btn);
            });
        } else {
            sceneSwitcher.style.display = 'none';
        }

        // Handle Dynamic Fields
        for (const key in config.fields) {
            const div = document.createElement('div');
            div.className = 'field';
            
            // Special Case: Ticker Speed Slider
            if (key === 'tickerSpeed') {
                div.innerHTML = `
                    <label>Ticker Speed: <span id="val-tickerSpeed">${config.fields[key]}</span>s</label>
                    <input type="range" id="edit-tickerSpeed" min="5" max="60" step="1" 
                           value="${config.fields[key]}" 
                           oninput="document.getElementById('val-tickerSpeed').innerText = this.value" />
                `;
            } 
            // Special Case: Ticker Play State Checkbox
            else if (key === 'tickerPlayState') {
                const isPaused = config.fields[key] === 'paused';
                div.innerHTML = `
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                        <input type="checkbox" id="pauseToggle" ${isPaused ? 'checked' : ''} 
                               style="width:auto; margin:0;" /> 
                        Pause Ticker
                    </label>
                    <input type="hidden" id="edit-tickerPlayState" value="${config.fields[key]}" />
                `;
                div.querySelector('#pauseToggle').onchange = (e) => {
                    $('edit-tickerPlayState').value = e.target.checked ? 'paused' : 'running';
                    window.renderHTMLLayout(window.currentRawHTML);
                };
            }
            // Default: Text Input
            else {
                div.innerHTML = `
                    <label style="text-transform:capitalize;">${key}</label>
                    <input type="text" id="edit-${key}" value="${config.fields[key]}" class="stream-title-input" />
                `;
            }
            fieldContainer.appendChild(div);
        }
    }

    // 4. Wrap originalRender to inject dashboard variables
    window.renderHTMLLayout = function(htmlString) {
        let processed = htmlString;
        
        // Find and replace all dynamic field placeholders
        const inputs = document.querySelectorAll('#dynamicFields input');
        inputs.forEach(input => {
            const key = input.id.replace('edit-', '');
            const val = input.value;
            const regex = new RegExp(`{{${key}}}`, 'g');
            processed = processed.replace(regex, val);
        });

        // Replace scene placeholder
        processed = processed.replace(/{{activeScene}}/g, window.activeScene);

        // Pass processed HTML back to the original engine in app.js
        originalRender(processed);
    };

    // 5. Expose Public API for external/tool control
    window.updateOverlayField = (key, value) => {
        const input = $(`edit-${key}`);
        if (input) {
            input.value = value;
            // Update slider display text if applicable
            const display = $(`val-${key}`);
            if (display) display.innerText = value;
        }
        window.renderHTMLLayout(window.currentRawHTML);
    };

    window.setOverlayScene = (sceneName) => {
        window.activeScene = sceneName;
        window.renderHTMLLayout(window.currentRawHTML);
    };

    // Manual Apply button trigger
    if ($('applyChangesBtn')) {
        $('applyChangesBtn').onclick = () => window.renderHTMLLayout(window.currentRawHTML);
    }

    // 🔌 RebelAPI bridge: listen for messages from tools (iframes)
    window.addEventListener('message', (event) => {
        const data = event.data || {};

        if (data.type === 'REBEL_CONTROL') {
            // Tools calling RebelAPI.setField(key, value)
            if (data.action === 'setField' && data.key) {
                if (typeof window.updateOverlayField === 'function') {
                    window.updateOverlayField(data.key, data.value);
                }
            }

            // Tools calling RebelAPI.setScene(sceneName)
            if (data.action === 'setScene' && data.sceneName) {
                if (typeof window.setOverlayScene === 'function') {
                    window.setOverlayScene(data.sceneName);
                }
            }
        }

        if (data.type === 'REBEL_CHAT' && data.text) {
            // Optional: pipe tool messages into your chat UI
            if (typeof window.appendSystemMessage === 'function') {
                window.appendSystemMessage(`[TOOL] ${data.text}`);
            }
        }
    });
})();
