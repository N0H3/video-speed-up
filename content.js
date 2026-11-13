// --- КОНФИГУРАЦИЯ ---
const MIN_SPEED = 1.0;
const MAX_SPEED = 4.0;
const SPEED_STEP = 0.2;
const ACTIVATION_DELAY = 200;
const LOCK_THRESHOLD_Y = -30;
const UNLOCK_THRESHOLD_Y = 40;
const DEFAULT_SPEED = 1.0;
const MOVE_THRESHOLD = 40;
const DRAG_ABORT_DISTANCE = 200;   // если курсор ушёл дальше - отменяем жест
const NATIVE_CONTROLS_HEIGHT = 56; // нижняя зона видео с нативными контролами
const PERSIST_INTERVAL = 700;      // как часто переустанавливаем "зафиксированную" скорость
const VIDEO_SCAN_INTERVAL = 500;   // перепроверка активного видео
const STALE_DRAG_MS = 6000;        // сколько ждать без движения мыши, прежде чем считать жест "залипшим"

// --- СОСТОЯНИЕ ---
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let activeVideo = null;
let hudElement = null;
let hudContainer = null;
let speedText = null;
let flameIcon = null;
let currentSpeed = 1.0;
let isSpeedLocked = false;
let isActiveMode = false;
let activationTimer = null;
let searchInterval = null;
let persistTimer = null;
let safetyTimer = null;
let lastMoveTime = 0;
let isExtensionEnabled = true;
let isInitialized = false;
let persistSpeed = null;       // скорость, которую держим после отпускания (фиксация)
let shadowRoots = [];          // найденные open shadow roots
let domObserver = null;
let scanQueued = false;
let pageHasVideo = false;      // есть ли на странице хоть одно видео (быстрый выход)
let hudVisible = false;         // показан ли HUD (сохраняем между пересборками)
const processedVideos = new WeakSet();

// --- ОГОНЁК (SVG, чтобы одинаково рисовался в любом браузере) ---
const FLAME_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="vsFlameGrad" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ff2d00"/><stop offset="45%" stop-color="#ff9100"/><stop offset="100%" stop-color="#ffd83d"/></linearGradient></defs><path fill="url(#vsFlameGrad)" d="M12.9 1.4c.4 3-1.3 4.4-2.9 5.8C8.4 8.7 6.7 10.5 6.7 13.6c0 3.4 2.5 5.7 5.4 5.7s5.4-2.3 5.4-5.7c0-2.1-.9-3.7-1.9-5-.3 1.1-1 1.8-1.9 2.1.5-3-.6-6.2-1-9.3z"/><path fill="#ffe469" d="M12 10.2c1.3 1.5 2.3 2.6 2.3 4.1a2.3 2.3 0 0 1-4.6 0c0-1.6 1.1-2.7 2.3-4.1z"/></svg>`;

// --- БЕЗОПАСНЫЕ ХЕЛПЕРЫ ---
function log(msg) { /* console.log(`[VS] ${msg}`); */ }

function tokenize(str) {
    if (!str) return [];
    return String(str)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-zA-Z0-9]+/)
        .map(t => t.toLowerCase())
        .filter(Boolean);
}

function elementTokens(el) {
    if (!el) return [];
    let cls = '';
    if (typeof el.className === 'string') cls = el.className;
    else if (el.getAttribute) cls = el.getAttribute('class') || '';
    const tokens = tokenize(cls);
    if (el.id) tokens.push(...tokenize(el.id));
    return tokens;
}

// Слова, по которым элемент считается «контейнером плеера»
const PLAYER_WORDS = new Set(['player', 'players', 'kodik', 'videojs', 'jwplayer', 'shaka', 'dashjs',
    'watch', 'embed', 'html5', 'theater', 'cinephile', 'media', 'stream', 'movie', 'video']);
// Слова, по которым элемент считается «кнопкой/контролом»
const CONTROL_WORDS = new Set(['btn', 'btns', 'button', 'buttons', 'icon', 'icons', 'menu', 'setting',
    'settings', 'option', 'options', 'volume', 'mute', 'quality', 'play', 'pause', 'fullscreen',
    'subtitle', 'subtitles', 'caption', 'captions', 'timeline', 'seek', 'progress', 'scrub', 'scrubber',
    'playlist', 'share', 'download', 'pip', 'autoplay', 'speed', 'rate', 'zoom', 'expand', 'collapse',
    'next', 'prev', 'previous', 'forward', 'rewind', 'favorite', 'like', 'dislike', 'comment',
    'cast', 'chapter', 'gear', 'lang', 'skip', 'toggle', 'switch', 'arrow', 'resize', 'spoiler',
    'toolbar', 'tab', 'range', 'seekbar', 'timebar', 'sound', 'closedcaption']);

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option', 'audio']);
const INTERACTIVE_ROLES = new Set(['button', 'slider', 'switch', 'checkbox', 'radio', 'link', 'menuitem',
    'menuitemcheckbox', 'tab', 'listbox', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'scrollbar']);
const ARIA_ACTION_RE = /(mute|unmute|volume|play|pause|fullscreen|quality|speed|setting|menu|close|skip|next|previous|share|download|zoom|caption|subtitle|closed.?caption|picture.?in.?picture|popout|rewind|forward)/i;

function hasPlayerWord(el) {
    return elementTokens(el).some(t => PLAYER_WORDS.has(t));
}

function isInteractiveElement(target, e) {
    if (!target) return false;
    const tagName = (target.tagName || '').toLowerCase();

    if (tagName === 'video') return false;              // само видео мы перехватываем
    if (INTERACTIVE_TAGS.has(tagName)) return true;
    if (target.type && ['range', 'checkbox', 'radio'].includes(target.type)) return true;

    const role = target.getAttribute ? (target.getAttribute('role') || '').toLowerCase() : '';
    if (INTERACTIVE_ROLES.has(role)) return true;

    // Twitch / Kodik / прочие плееры с атрибутами-метками
    if (target.getAttribute) {
        if (target.getAttribute('data-a-target')) return true;
        if (target.getAttribute('data-testid')) return true;
        if (target.getAttribute('onclick')) return true;
        const aria = target.getAttribute('aria-label');
        if (aria && ARIA_ACTION_RE.test(aria)) return true;
    }

    // Классы/идентификаторы: сам элемент + ближайшие предки
    let el = target;
    let depth = 0;
    while (el && el !== document.body && el !== document.documentElement && depth < 6) {
        const tokens = elementTokens(el);
        const wrapsVideo = activeVideo && el.contains && el.contains(activeVideo);

        for (const t of tokens) {
            if (CONTROL_WORDS.has(t)) return true;
        }
        // Панель управления (controls) — это не обёртка видео, значит кликать нельзя
        if (!wrapsVideo && (tokens.indexOf('controls') !== -1 || tokens.indexOf('control') !== -1)) return true;

        el = el.parentElement;
        depth++;
    }

    // Эвристики (курсор-указатель / фокусируемость) — только если клик НЕ по самому видео,
    // иначе перехватим оверлей поверх ролика
    const overVideo = (e && isPointOverVideo(e)) ||
        tagName === 'video' || (target.closest && target.closest('video'));
    if (!overVideo) {
        if (typeof target.tabIndex === 'number' && target.tabIndex >= 0 && tagName !== 'body') return true;
        try {
            const st = window.getComputedStyle(target);
            if (st && st.cursor === 'pointer') return true;
        } catch (err) { }
    }
    return false;
}

// Попадание в зону нативных контролов (<video controls>)
function isNativeControlsZone(e, target) {
    let v = null;
    if (target && target.closest) v = target.closest('video');
    if (!v) v = activeVideo || findActiveVideo();
    if (!v || !v.hasAttribute || !v.hasAttribute('controls')) return false;
    const r = v.getBoundingClientRect();
    if (!r || r.width < 60) return false;
    if (e.clientY < r.top || e.clientY > r.bottom) return false;
    return (r.bottom - e.clientY) <= NATIVE_CONTROLS_HEIGHT;
}

// --- УПРАВЛЕНИЕ СОСТОЯНИЕМ ---
function updateEnabledState(enabled) {
    isExtensionEnabled = enabled;

    if (!isExtensionEnabled) {
        stopAllTimers();
        hideHUD();
        isDragging = false;
        isActiveMode = false;
        isSpeedLocked = false;
        persistSpeed = null;
        resetDragStyles();
        if (activeVideo) {
            activeVideo.removeEventListener('pause', hardPauseBlocker, true);
            try { processedVideos.delete(activeVideo); } catch (e) { }
            try { activeVideo.playbackRate = 1; } catch (e) { }
        }
    } else {
        if (!isInitialized) {
            safeInit();
        }
        if (!searchInterval) startSearchLoop();
        if (!persistTimer) startPersistLoop();
        if (activeVideo) ensurePauseInterceptor(activeVideo);
    }
}

function safeStorageGet(key, cb) {
    try {
        chrome.storage.sync.get([key], (res) => {
            if (chrome.runtime.lastError) {
                try { chrome.storage.local.get([key], (r2) => cb(r2 ? r2[key] : undefined)); }
                catch (e) { cb(undefined); }
            } else cb(res ? res[key] : undefined);
        });
    } catch (e) { cb(undefined); }
}

safeStorageGet('isEnabled', (val) => {
    updateEnabledState(val !== false);
});

window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'VideoSpeedExtension' && event.data.action === 'toggleState') {
        updateEnabledState(!!event.data.enabled);
    }
});

try {
    chrome.runtime.onMessage.addListener((request) => {
        if (request && request.action === 'toggleState') updateEnabledState(!!request.enabled);
    });
} catch (e) { }

// Переключение из popup подхватываем автоматически во всех вкладках
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (changes && changes.isEnabled) {
            updateEnabledState(changes.isEnabled.newValue !== false);
        }
    });
} catch (e) { }

// --- ИНИЦИАЛИЗИАЦИЯ ---
(function () {
    safeInit();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (!isInitialized) safeInit();
        });
    }
})();

function safeInit() {
    if (isInitialized) return;

    window.addEventListener('mousedown', function (e) { safeCall(onMouseDown, e); }, { capture: true, passive: false });
    window.addEventListener('mousemove', function (e) { safeCall(onMouseMove, e); }, { capture: true, passive: false });
    window.addEventListener('mouseup', function (e) { safeCall(onMouseUp, e); }, { capture: true, passive: false });
    window.addEventListener('pointerup', function (e) { safeCall(onPointerUp, e); }, { capture: true, passive: false });
    window.addEventListener('pointercancel', function (e) { safeCall(onPointerUp, e); }, { capture: true, passive: false });
    window.addEventListener('click', function (e) { safeCall(onClickBlocker, e); }, { capture: true, passive: false });
    window.addEventListener('blur', function () { safeCall(forceResetDrag); }, { capture: true });
    window.addEventListener('pagehide', function () { safeCall(forceResetDrag); }, { capture: true });
    document.addEventListener('visibilitychange', function () { safeCall(onVisibilityChange); });
    document.addEventListener('mouseout', function (e) { safeCall(onDocumentMouseOut, e); }, { capture: true });

    refreshShadowRoots();
    startDomObserver();
    startSearchLoop();
    startPersistLoop();
    startSafetyWatchdog();

    isInitialized = true;
}

// --- ПРИНУДИТЕЛЬНЫЙ СБРОС ---
// document.body бывает null (about:blank фреймы, документы без <body>),
// поэтому работаем через безопасный хелпер и никогда не падаем.
function getStyleHost() {
    try {
        return document.body || document.documentElement || null;
    } catch (e) {
        return null;
    }
}

// Стили на время перетаскивания: прячем курсор и запрещаем выделение текста
function startDragStyles() {
    const host = getStyleHost();
    if (!host || !host.style) return;
    try {
        host.style.setProperty('cursor', 'none', 'important');
        host.style.setProperty('user-select', 'none', 'important');
    } catch (e) { }
}

function resetDragStyles() {
    const host = getStyleHost();
    if (!host || !host.style) return;
    try {
        host.style.removeProperty('cursor');
        host.style.removeProperty('user-select');
    } catch (e) { }
}

// Любая непредвиденная ошибка в обработчике не должна попадать в консоль страницы
function safeCall(fn) {
    try {
        return fn.apply(null, arguments);
    } catch (e) {
        log('error: ' + (e && e.message ? e.message : e));
        return undefined;
    }
}

function forceResetDrag() {
    if (isDragging) {
        log("Force reset (blur)");
        onMouseUp({ preventDefault: () => { }, stopPropagation: () => { } });
    } else {
        // даже если перетаскивание уже сброшено — гасим активный режим
        isActiveMode = false;
        isSpeedLocked = false;
        hideHUD();
        resetDragStyles();
    }
}

// Мышь отпущена вне окна / вкладка скрыта — сбрасываем всё
function onPointerUp(e) {
    if (isDragging || isActiveMode) {
        onMouseUp(e);
    }
}

function onVisibilityChange() {
    if (document.visibilityState !== 'visible') {
        forceResetDrag();
    }
}

// Страховка: если активный режим «завис» (потерян mouseup) — гасим его
function startSafetyWatchdog() {
    if (safetyTimer) clearInterval(safetyTimer);
    safetyTimer = setInterval(function () {
        safeCall(function () {
            if (!isActiveMode) return;
            // 1) перетаскивание уже закончилось, а активный режим остался
            // 2) мышь «залипла» нажатой — давно не было движения
            const stale = !isDragging || (Date.now() - lastMoveTime > STALE_DRAG_MS);
            if (stale) {
                log("Safety watchdog: reset stuck active mode");
                isActiveMode = false;
                isDragging = false;
                isSpeedLocked = false;
                if (activationTimer) clearTimeout(activationTimer);
                hideHUD();
                resetDragStyles();
            }
        });
    }, 700);
}

function onDocumentMouseOut(e) {
    if (isDragging && e.relatedTarget === null) {
        log("Force reset (mouseout from iframe)");
        onMouseUp({ preventDefault: () => { }, stopPropagation: () => { } });
    }
}

// --- ПЕРЕХВАТЧИК ПАУЗЫ ---
function hardPauseBlocker(e) {
    try {
        if (isActiveMode || isDragging) {
            e.preventDefault();
            e.stopPropagation();
            if (activeVideo) {
                try { activeVideo.focus({ preventScroll: true }); } catch (err) {
                    try { activeVideo.focus(); } catch (e2) { }
                }
                activeVideo.play().catch(() => { });
                setTimeout(function () {
                    safeCall(function () {
                        if (activeVideo && activeVideo.paused) {
                            activeVideo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        }
                    });
                }, 10);
            }
            return false;
        }
    } catch (err) { }
}

function ensurePauseInterceptor(video) {
    if (!video || processedVideos.has(video)) return;
    processedVideos.add(video);

    video.addEventListener('pause', hardPauseBlocker, true);

    // Некоторые плееры сбрасывают скорость при смене качества/источника — возвращаем
    video.addEventListener('loadedmetadata', () => {
        if (persistSpeed !== null) {
            try {
                video.playbackRate = persistSpeed;
                video.defaultPlaybackRate = persistSpeed;
            } catch (e) { }
        }
    });

    video.addEventListener('mouseleave', () => {
        if (isDragging && !isActiveMode) {
            setTimeout(() => {
                if (isDragging && !isActiveMode) {
                    isDragging = false;
                    resetDragStyles();
                    if (activationTimer) clearTimeout(activationTimer);
                    log("Drag reset on mouseleave");
                }
            }, 50);
        }
    }, { capture: true });
}

// --- ВИЗУАЛИЗАЦИЯ (HUD) ---
function buildHUD() {
    hudElement = document.createElement('div');
    hudElement.id = 'global-speed-hud';

    // ТОЛЬКО: огонёк + белая цифра с чёрной обводкой
    const right = document.createElement('div');
    right.style.cssText = 'display:flex !important;align-items:center !important;gap:6px !important;';

    flameIcon = document.createElement('span');
    flameIcon.id = 'speed-flame';
    flameIcon.style.cssText = 'display:flex !important;align-items:center !important;filter:drop-shadow(0 2px 4px rgba(0,0,0,.75)) !important;transform-origin:center bottom !important;';
    flameIcon.innerHTML = FLAME_SVG;

    speedText = document.createElement('div');
    speedText.id = 'speed-text';
    speedText.style.cssText = 'font-size:26px !important;font-weight:900 !important;color:#ffffff !important;-webkit-text-stroke:3px #000000 !important;paint-order:stroke !important;text-shadow:0 2px 8px rgba(0,0,0,.95) !important;line-height:1 !important;letter-spacing:-.5px !important;';
    speedText.textContent = '1.0';

    right.appendChild(flameIcon);
    right.appendChild(speedText);

    hudElement.appendChild(right);
}

function resolveHudContainer() {
    const body = document.body || document.documentElement;
    if (!activeVideo) return body;

    // Поднимаемся вверх, ищем обёртку плеера
    let el = activeVideo.parentElement;
    for (let i = 0; i < 4 && el && el !== document.body; i++) {
        const r = el.getBoundingClientRect();
        const bigEnough = r.width > 260 && r.height > 120;
        if (hasPlayerWord(el) && bigEnough) return el;
        el = el.parentElement;
    }

    // иначе — ближайший родитель видео (если он достаточно широкий)
    const parent = activeVideo.parentElement;
    if (parent && parent !== document.body) {
        const pr = parent.getBoundingClientRect();
        if (pr.width >= 240) return parent;
    }
    return body;
}

function ensureHUD() {
    const target = resolveHudContainer();
    if (!target) return;

    if (!hudElement) {
        buildHUD();
    } else if (hudContainer && hudContainer !== target && hudContainer.isConnected) {
        hudElement.remove();     // переносим в новый контейнер (SPA-переход)
        hudElement = null;
        buildHUD();
    }

    if (!hudElement) return;

    const isBody = target === document.body;
    try {
        const compStyle = window.getComputedStyle(target);
        if (compStyle.position === 'static') {
            target.style.position = 'relative';
        }
    } catch (e) { }

    hudElement.style.cssText = `
        position: ${isBody ? 'fixed' : 'absolute'} !important;
        top: ${isBody ? '14px' : '10px'} !important;
        right: ${isBody ? '14px' : '10px'} !important;
        left: auto !important;
        bottom: auto !important;
        transform: none !important;
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 0 !important;
        margin: 0 !important;
        background: none !important;
        border: none !important;
        box-shadow: none !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        transition: opacity 0.12s ease !important;
        box-sizing: content-box !important;
        user-select: none !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif !important;
    `;

    if (hudElement.parentElement !== target) target.appendChild(hudElement);
    hudContainer = target;
    if (hudVisible) hudElement.style.transition = 'none';
    hudElement.style.opacity = hudVisible ? '1' : '0';
    updateVisuals();
}

function updateVisuals() {
    if (!hudElement || !speedText) return;

    speedText.textContent = currentSpeed.toFixed(1);

    // Огонёк растёт вместе со скоростью, при фиксации подсвечивается
    if (flameIcon) {
        const pct = Math.min(Math.max(((currentSpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100, 0), 100);
        const k = 0.82 + (pct / 100) * 0.35;
        const fixed = isSpeedLocked || persistSpeed !== null;
        flameIcon.style.transform = `scale(${k.toFixed(3)})`;
        flameIcon.style.setProperty('filter', fixed
            ? 'drop-shadow(0 0 7px rgba(255,216,61,0.95)) drop-shadow(0 2px 4px rgba(0,0,0,0.75))'
            : 'drop-shadow(0 2px 4px rgba(0,0,0,0.75))', 'important');
    }
}

// Показ — мгновенно (не зависит от анимаций, в фоновой вкладке переходы не идут),
// скрытие — плавно
function showHUD() {
    hudVisible = true;
    if (!hudElement) return;
    hudElement.style.transition = 'none';
    hudElement.style.opacity = '1';
}
function hideHUD() {
    hudVisible = false;
    if (!hudElement) return;
    hudElement.style.transition = '';
    hudElement.style.opacity = '0';
}

// --- ПОИСК ВИДЕО ---
// Признаки рекламных видео (нужно, чтобы не выбрать рекламу вместо фильма)
const AD_WORDS = new Set(['ads', 'ad', 'adsbox', 'addsdiv', 'adcontainer', 'adv', 'vast', 'preroll',
    'pre-roll', 'roll', 'creative', 'vpaid', 'banner', 'commercial', 'advert', 'advertising',
    'promo', 'popunder', 'interstitial', 'sponsor']);

function hasAdAncestor(v) {
    let el = v.parentElement;
    let depth = 0;
    while (el && el !== document.body && el !== document.documentElement && depth < 6) {
        const tokens = elementTokens(el);
        if (tokens.some(t => AD_WORDS.has(t))) return true;
        el = el.parentElement;
        depth++;
    }
    return false;
}

function scoreVideo(v) {
    let score = 0;
    try {
        const r = v.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) score += 50;
        else if (r.width > 20 && r.height > 20) score += 10;
    } catch (e) { }
    if (v.videoWidth && v.videoHeight) score += 25;   // реальное видео с данными
    if (v.readyState >= 1) score += 5;
    if (!v.paused) score += 30;                      // сейчас играет
    if (!v.isConnected) score -= 200;
    // реклама (VAST/VPAID/преролл) — понижаем приоритет, чтобы выбрать сам фильм
    if (hasAdAncestor(v)) score -= 60;
    try {
        const st = window.getComputedStyle(v);
        if (st.display === 'none') score -= 60;
        // Kodik/некоторые плееры держат <video> скрытым и рисуют кадры сами —
        // поэтому штраф небольшой, иначе такое видео вообще не найдётся
        else if (st.visibility === 'hidden') score -= 10;
        if (st.opacity === '0') score -= 5;
    } catch (e) { }
    return score;
}

function collectShadowRoots(root, out) {
    out = out || [];
    let nodes = [];
    try { nodes = root.querySelectorAll('*'); } catch (e) { return out; }
    for (const el of nodes) {
        if (el.shadowRoot) {
            out.push(el.shadowRoot);
            collectShadowRoots(el.shadowRoot, out);   // вложенные тени тоже сохраняем
        }
    }
    return out;
}

// Обновляем список найденных shadow root
function refreshShadowRoots() {
    const roots = collectShadowRoots(document);
    for (const r of roots) {
        if (shadowRoots.indexOf(r) === -1) shadowRoots.push(r);
    }
}

// Реальная цель события: вне shadow DOM e.target указывает на ХОСТ тени,
// а настоящий элемент лежит в e.composedPath()[0]
function getRealTarget(e) {
    if (!e) return null;
    if (e.composedPath && e.composedPath().length) {
        const first = e.composedPath()[0];
        if (first && first.nodeType === 1) return first;
    }
    return e.target;
}

function findActiveVideo() {
    const videos = [];
    const push = (v) => { if (v && videos.indexOf(v) === -1) videos.push(v); };

    try { document.querySelectorAll('video').forEach(push); } catch (e) { }
    for (const sr of shadowRoots) {
        try { sr.querySelectorAll('video').forEach(push); } catch (e) { }
    }
    pageHasVideo = videos.length > 0;

    let best = null;
    let bestScore = 0;
    for (const v of videos) {
        const s = scoreVideo(v);
        if (s > bestScore) { bestScore = s; best = v; }
    }
    return bestScore > 0 ? best : null;
}

function startSearchLoop() {
    if (searchInterval) clearInterval(searchInterval);
    searchInterval = setInterval(function () {
        safeCall(function () {
            if (!isExtensionEnabled) return;
            if (isDragging) return;

            const stale = !activeVideo || !activeVideo.isConnected;
            if (stale) {
                // плеер мог спрятать видео в shadow root, которого мы ещё не знаем
                if (shadowRoots.length === 0) refreshShadowRoots();

                activeVideo = findActiveVideo();
                if (activeVideo) {
                    ensurePauseInterceptor(activeVideo);
                    ensureHUD();
                }
            }
        });
    }, VIDEO_SCAN_INTERVAL);
}

// Следим за DOM, чтобы ловить плееры, которые появляются позже / в shadow DOM
function startDomObserver() {
    if (domObserver) return;
    try {
        domObserver = new MutationObserver(function () {
            if (scanQueued) return;
            scanQueued = true;
            setTimeout(function () {
                scanQueued = false;
                safeCall(function () {
                    refreshShadowRoots();

                    if (!activeVideo || !activeVideo.isConnected) {
                        const v = findActiveVideo();
                        if (v) {
                            activeVideo = v;
                            ensurePauseInterceptor(v);
                            ensureHUD();
                        }
                    }
                });
            }, 1200);
        });
        domObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { }
}

// Держим зафиксированную скорость, если плеер её сбрасывает
function startPersistLoop() {
    if (persistTimer) clearInterval(persistTimer);
    persistTimer = setInterval(function () {
        safeCall(function () {
            if (!isExtensionEnabled || persistSpeed === null) return;
            if (isDragging) return;
            const v = activeVideo;
            if (!v || !v.isConnected) return;
            try {
                if (Math.abs(v.playbackRate - persistSpeed) > 0.01) {
                    v.playbackRate = persistSpeed;
                    v.defaultPlaybackRate = persistSpeed;
                }
            } catch (e) { }
        });
    }, PERSIST_INTERVAL);
}

function setSpeed(val) {
    let rounded = Math.round(val * 10) / 10;
    if (rounded < MIN_SPEED) rounded = MIN_SPEED;
    if (rounded > MAX_SPEED) rounded = MAX_SPEED;
    currentSpeed = rounded;
    if (activeVideo) {
        try {
            activeVideo.playbackRate = currentSpeed;
            activeVideo.defaultPlaybackRate = currentSpeed;
        } catch (e) { }
    }
    updateVisuals();
}

function stopAllTimers() {
    if (activationTimer) clearTimeout(activationTimer);
    if (searchInterval) clearInterval(searchInterval);
    if (persistTimer) clearInterval(persistTimer);
    activationTimer = null;
    searchInterval = null;
    persistTimer = null;
}

// --- ГЕОМЕТРИЯ ---
function getVideoRect(v) {
    if (!v) return null;
    let r = null;
    try { r = v.getBoundingClientRect(); } catch (e) { return null; }
    if (r && r.width > 40 && r.height > 40) return r;

    // видео "невидимое" (1x1) — берём размер родителя, но не шире экрана
    let p = v.parentElement;
    for (let i = 0; i < 2 && p; i++) {
        let pr = null;
        try { pr = p.getBoundingClientRect(); } catch (e) { break; }
        if (pr && pr.width > 40 && pr.height > 40 && pr.width < window.innerWidth * 0.95) return pr;
        p = p.parentElement;
    }
    return r;
}

function isPointOverVideo(e) {
    const v = activeVideo || findActiveVideo();
    const r = getVideoRect(v);
    if (!r || r.width < 40 || r.height < 40) return false;
    const pad = 8;
    return e.clientX >= r.left - pad && e.clientX <= r.right + pad &&
        e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
}

function isInsidePlayerContainer(target) {
    let el = target;
    let depth = 0;
    while (el && el !== document.body && el !== document.documentElement && depth < 6) {
        if (hasPlayerWord(el)) return true;
        el = el.parentElement;
        depth++;
    }
    return false;
}
// ВНИМАНИЕ: isInsidePlayerContainer намеренно НЕ используется при активации.
// На многих сайтах рядом с видео лежит блок с названием (.video_info, .video-tags-bar),
// и клик по нему попадал бы в "контейнер плеера" — ломался бы выбор текста.

// --- ГИБРИДНАЯ ПРОВЕРКА ЦЕЛИ КЛИКА ---
// Активируем ТОЛЬКО когда клик пришёлся по самому видео или по оверлею поверх него.
// Проверять "контейнер плеера" нельзя: на многих сайтах рядом с видео лежит
// блок с названием (например .video_info) — клик по нему ломал выделение текста.
function shouldActivateOnTarget(target, e) {
    if (!target) return false;

    // 1. Клик прямо по видео (в т.ч. внутри shadow DOM)
    if (target.tagName === 'VIDEO') return true;
    if (target.closest && target.closest('video')) return true;

    // 2. Клик по оверлею/канвасу/постеру поверх видео (стримы, кастомные плееры)
    if (e && isPointOverVideo(e)) return true;

    return false;
}

// --- ОБРАБОТЧИКИ ---
function startActivationTimer() {
    if (activationTimer) clearTimeout(activationTimer);
    activationTimer = setTimeout(function () {
        safeCall(function () {
            if (isDragging && activeVideo) {
                isActiveMode = true;
                ensurePauseInterceptor(activeVideo);
                setSpeed(2.0);
                showHUD();
                activeVideo.play().catch(() => { });
            }
        });
    }, ACTIVATION_DELAY);
}

function onMouseDown(e) {
    if (!isExtensionEnabled) return;
    if (e.button !== 0) return;

    // Настоящая цель (в shadow DOM это не e.target, а элемент внутри тени)
    const target = getRealTarget(e);
    if (!target) return;

    // Если активное видео ещё не найдено (или вырвалось из DOM) — ищем заново
    if (!activeVideo || !activeVideo.isConnected) {
        activeVideo = findActiveVideo();
        if (!activeVideo) return;
    }

    // На странице может быть несколько видео — работаем с тем, по которому кликнули
    const videoUnderPointer = (target.closest && target.closest('video')) || null;
    if (videoUnderPointer && videoUnderPointer !== activeVideo) {
        activeVideo = videoUnderPointer;
        ensurePauseInterceptor(activeVideo);
    }

    // Клик по iframe (плеер в фрейме) — не перехватываем:
    // настоящий плеер живёт внутри кадра, там работает своя копия расширения
    if (target.tagName === 'IFRAME' || (target.closest && target.closest('iframe'))) return;

    // Нативные контролы видео (<video controls>) — не трогаем
    if (isNativeControlsZone(e, target)) return;

    // Кнопки/контролы плеера — не трогаем (это чинит "не работают кнопки")
    if (isInteractiveElement(target, e)) return;

    if (!shouldActivateOnTarget(target, e)) return;

    const potentialVideo = activeVideo && activeVideo.isConnected ? activeVideo : findActiveVideo();
    if (!potentialVideo) return;

    activeVideo = potentialVideo;
    ensurePauseInterceptor(activeVideo);
    ensureHUD();

    if (isActiveMode) {
        if (activationTimer) clearTimeout(activationTimer);
        currentSpeed = 2.0;
        isSpeedLocked = false;
    }

    // Новый жест сбрасывает "зафиксированную" скорость (будет задана заново при фиксации)
    persistSpeed = null;
    updateVisuals();

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    isActiveMode = false;
    lastMoveTime = Date.now();

    startActivationTimer();
    startDragStyles();

    // НЕ вызываем preventDefault/stopPropagation: это ломало выделение текста
    // на страницах, где рядом с видео лежит блок с названием.
    // Выделение текста блокируем только на время самого перетаскивания (user-select:none).
}

function onMouseMove(e) {
    lastMoveTime = Date.now();

    // Кнопка мыши уже отпущена, но mouseup мы потеряли (курсор ушёл за окно) — гасим жест
    if (isDragging && e.buttons === 0) {
        log("Mouse button released but mouseup lost");
        forceResetDrag();
        return;
    }

    // Курсор ушёл из iframe / слишком далеко до активации — отменяем жест
    if (isDragging && !isActiveMode && activeVideo) {
        const dist = Math.sqrt(Math.pow(e.clientX - dragStartX, 2) + Math.pow(e.clientY - dragStartY, 2));
        if (dist > DRAG_ABORT_DISTANCE) {
            log("Force reset on mousemove (distance)");
            isDragging = false;
            resetDragStyles();
            if (activationTimer) clearTimeout(activationTimer);
            return;
        }
    }

    if (!isDragging || !activeVideo || !isActiveMode) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    if (Math.abs(deltaX) > MOVE_THRESHOLD) {
        const steps = Math.floor(deltaX / MOVE_THRESHOLD);
        let newSpeed = currentSpeed + (steps * SPEED_STEP);
        if (newSpeed > MAX_SPEED) newSpeed = MAX_SPEED;
        if (newSpeed < MIN_SPEED) newSpeed = MIN_SPEED;

        if (newSpeed !== currentSpeed) {
            setSpeed(newSpeed);
            dragStartX = e.clientX - (deltaX % MOVE_THRESHOLD);
            activeVideo.play().catch(() => { });
        }
    }

    if (!isSpeedLocked && deltaY < LOCK_THRESHOLD_Y) {
        isSpeedLocked = true;
        updateVisuals();
        activeVideo.play().catch(() => { });
    } else if (isSpeedLocked && deltaY > UNLOCK_THRESHOLD_Y) {
        isSpeedLocked = false;
        persistSpeed = null;
        setSpeed(DEFAULT_SPEED);
        updateVisuals();
        activeVideo.play().catch(() => { });
    }
}

function onMouseUp(e) {
    if (!isDragging) return;

    if (activationTimer) clearTimeout(activationTimer);

    if (isActiveMode) {
        // клик по самому видео блокирует onClickBlocker, поэтому тут ничего не отменяем —
        // это не мешает сайту обрабатывать свои события и не ломает выделение текста

        if (isSpeedLocked) {
            // ФИКСАЦИЯ: скорость сохраняется после отпускания
            persistSpeed = currentSpeed;
            updateVisuals();
            if (activeVideo) {
                try {
                    activeVideo.playbackRate = persistSpeed;
                    activeVideo.defaultPlaybackRate = persistSpeed;
                } catch (e) { }
                activeVideo.play().catch(() => { });
            }

            setTimeout(() => {
                isActiveMode = false;
                hideHUD();
            }, 300);

            isDragging = false;
            isSpeedLocked = false;
            resetDragStyles();
            return;
        } else {
            persistSpeed = null;
            setSpeed(DEFAULT_SPEED);
            if (activeVideo) activeVideo.play().catch(() => { });

            setTimeout(() => {
                isActiveMode = false;
                hideHUD();
            }, 100);

            isDragging = false;
            isSpeedLocked = false;
            resetDragStyles();
        }
    } else {
        resetDragStyles();
    }

    isDragging = false;
    isSpeedLocked = false;
}

// Блокируем клик только по самому видео — кнопки плеера продолжают работать
function onClickBlocker(e) {
    if (!isExtensionEnabled || !isActiveMode) return;
    const t = getRealTarget(e);
    if (!t) return;
    if (t.tagName === 'VIDEO' || (t.closest && t.closest('video'))) {
        e.preventDefault();
        e.stopPropagation();
        return false;
    }
}
