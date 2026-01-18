(function() {
    const $ = id => document.getElementById(id);
    const htmlInput = $('htmlOverlayInput');
    const originalRender = window.renderHTMLLayout; //

    window.currentRawHTML = "";
    window.activeScene = "Full";

    if (htmlInput) {
        htmlInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                window.currentRawHTML = event.target.result;
                const doc = new DOMParser().parseFromString(window.currentRawHTML, 'text/html');
                const configScript = doc.getElementById('overlay-config');

                if (configScript) {
                    try {
                        const config = JSON.parse(configScript.textContent);
                        setupDashboard(config);
                        $('liveEditor').style.display = 'block';
                    } catch (err) { console.error("Config Error", err); }
                }
                renderHTMLLayout(window.currentRawHTML); //
            };
            reader.readAsText(file);
        });
    }

    function setupDashboard(config) {
        const dynamicFields = $('dynamicFields');
        const sceneGroup = $('sceneBtnGroup');
        dynamicFields.innerHTML = '';
        sceneGroup.innerHTML = '';

        if (config.scenes) {
            $('sceneSwitcher').style.display = 'block';
            config.scenes.forEach(scene => {
                const btn = document.createElement('button');
                btn.className = 'mixer-btn';
                btn.textContent = scene;
                btn.onclick = () => {
                    window.activeScene = scene;
                    renderHTMLLayout(window.currentRawHTML); //
                    document.querySelectorAll('.mixer-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                };
                sceneGroup.appendChild(btn);
            });
        }

        for (const key in config.fields) {
            const div = document.createElement('div');
            div.className = 'field';
            if (key === 'tickerSpeed') {
                div.innerHTML = `<label>Speed: <span id="val-speed">${config.fields[key]}</span>s</label>
                                 <input type="range" id="edit-tickerSpeed" min="5" max="60" value="${config.fields[key]}" oninput="$('val-speed').innerText = this.value" />`;
            } else if (key === 'tickerPlayState') {
                div.innerHTML = `<label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="pauseToggle" ${config.fields[key] === 'paused' ? 'checked' : ''} style="width:auto; margin:0;"/> Pause Ticker</label>
                                 <input type="hidden" id="edit-tickerPlayState" value="${config.fields[key]}" />`;
                div.querySelector('#pauseToggle').onchange = (e) => {
                    $('edit-tickerPlayState').value = e.target.checked ? 'paused' : 'running';
                    renderHTMLLayout(window.currentRawHTML); //
                };
            } else {
                div.innerHTML = `<label>${key}</label><input type="text" id="edit-${key}" value="${config.fields[key]}" class="stream-title-input" />`;
            }
            dynamicFields.appendChild(div);
        }
    }

    window.renderHTMLLayout = function(htmlString) {
        let processed = htmlString;
        document.querySelectorAll('#dynamicFields input').forEach(input => {
            const key = input.id.replace('edit-', '');
            processed = processed.replace(new RegExp(`{{${key}}}`, 'g'), input.value);
        });
        processed = processed.replace(/{{activeScene}}/g, window.activeScene || 'Full');
        originalRender(processed); //
    };

    $('applyChangesBtn').onclick = () => renderHTMLLayout(window.currentRawHTML); //
})();
