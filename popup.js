document.addEventListener('DOMContentLoaded', () => {
    const toggleBtn = document.getElementById('toggleBtn');
    const statusDiv = document.getElementById('status');

    // Читаем настройку: сначала sync, при ошибке — local (надёжнее в разных браузерах)
    function readSetting(cb) {
        try {
            chrome.storage.sync.get(['isEnabled'], (result) => {
                if (chrome.runtime.lastError) {
                    chrome.storage.local.get(['isEnabled'], (r2) => cb(r2 ? r2.isEnabled : undefined));
                } else {
                    cb(result ? result.isEnabled : undefined);
                }
            });
        } catch (e) {
            cb(undefined);
        }
    }

    function writeSetting(value, cb) {
        try {
            chrome.storage.sync.set({ isEnabled: value }, () => {
                if (chrome.runtime.lastError) {
                    chrome.storage.local.set({ isEnabled: value }, () => cb && cb());
                } else {
                    cb && cb();
                }
            });
        } catch (e) {
            try { chrome.storage.local.set({ isEnabled: value }, () => cb && cb()); } catch (e2) { cb && cb(); }
        }
    }

    readSetting((value) => {
        const isEnabled = value !== false;
        updateUI(isEnabled);
    });

    toggleBtn.addEventListener('click', () => {
        readSetting((value) => {
            const newState = !(value !== false);

            writeSetting(newState, () => {
                updateUI(newState);
            });

            // 1. Стандартное сообщение (для главных страниц)
            chrome.runtime.sendMessage({
                action: 'toggleState',
                enabled: newState
            }).catch(err => { }); // Игнорируем ошибку, если нет получателей

            // 2. ОТРАВКА ЧЕРЕЗ POSTMESSAGE (ДЛЯ IFRAME И KODIK)
            // Отправляем сообщение во все вкладки и фреймы
            window.postMessage({
                source: 'VideoSpeedExtension',
                action: 'toggleState',
                enabled: newState
            }, '*');

            // Также пытаемся отправить во все iframe текущей вкладки (если popup имеет доступ)
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0] && tabs[0].id) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'toggleState',
                        enabled: newState
                    }).catch(() => { });
                }
            });
        });
    });

    function updateUI(isEnabled) {
        if (isEnabled) {
            toggleBtn.textContent = 'ОТКЛЮЧИТЬ';
            toggleBtn.className = 'btn-off';
            statusDiv.textContent = 'Расширение активно';
        } else {
            toggleBtn.textContent = 'ВКЛЮЧИТЬ';
            toggleBtn.className = 'btn-on';
            statusDiv.textContent = 'Расширение выключено';
        }
    }
});