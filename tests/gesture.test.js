// Регрессионный тест жестов расширения "Video Speed Up" на эмуляции DOM (jsdom).
//
// Запуск:
//   npm install jsdom
//   node tests/gesture.test.js
//
// Тест проверяет то, что нельзя проверить глазами в браузере:
//  - обработчики получают настоящий MouseEvent (а не функцию) — регрессия v1.0.1..1.0.2
//  - активация по удержанию, тяга вправо/влево, фиксация вверх, сброс вниз
//  - кнопки плеера и текст рядом с видео не перехватываются
//  - исходные стили страницы восстанавливаются после жеста
//  - анти-залипание при потерянном mouseup (e.buttons === 0)

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom'); // npm install jsdom

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function setupVideo(dom) {
  const { window } = dom;
  let rate = 1;
  let paused = false;

  const v = window.document.querySelector('video');
  v.getBoundingClientRect = () => ({ left: 40, top: 40, right: 680, bottom: 400, width: 640, height: 360, x: 40, y: 40, toJSON() {} });
  Object.defineProperty(v, 'playbackRate', { get: () => rate, set: (x) => { rate = x; }, configurable: true });
  Object.defineProperty(v, 'defaultPlaybackRate', { get: () => 1, set: () => {}, configurable: true });
  Object.defineProperty(v, 'videoWidth', { get: () => 640, configurable: true });
  Object.defineProperty(v, 'videoHeight', { get: () => 360, configurable: true });
  Object.defineProperty(v, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(v, 'paused', { get: () => paused, set: (x) => { paused = x; }, configurable: true });
  Object.defineProperty(v, 'duration', { get: () => 600, configurable: true });
  Object.defineProperty(v, 'currentTime', { get: () => 10, set: () => {}, configurable: true });
  v.play = () => { paused = false; return Promise.resolve(); };
  v.pause = () => { paused = true; };
  v.focus = () => {};
  return { v, getRate: () => rate };
}

// Событие диспатчим НА ЭЛЕМЕНТ (как в браузере), оно всплывает до window-capture
function fireOn(el, type, x, y, buttons) {
  const window = el.ownerDocument.defaultView;
  const e = new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    button: 0, buttons, view: window,
  });
  el.dispatchEvent(e);
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = [];
  const check = (name, cond, extra) => results.push({ name, pass: !!cond, extra });

  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="player"><video></video></div>
    <div class="video_info">Text that must stay selectable</div>
  </body></html>`, {
    url: 'https://example.com/watch',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { getRate, v } = setupVideo(dom);

  const PROBE = `;({__p:{
    get activeVideo(){return activeVideo},
    get isActiveMode(){return isActiveMode},
    get isDragging(){return isDragging},
    get currentSpeed(){return currentSpeed},
    get isSpeedLocked(){return isSpeedLocked},
    get persistSpeed(){return persistSpeed},
    get hud(){return hudElement},
    findActiveVideo:findActiveVideo
  }})`;
  const P = window.eval(SRC + PROBE).__p;
  const hudOpacity = () => (P.hud ? P.hud.style.opacity : 'no-hud');

  await sleep(300);
  check('видео найдено автоматически', !!P.findActiveVideo());

  // --- 1. Активация удержанием ---
  fireOn(v, 'mousedown', 360, 220, 1);
  check('mousedown по видео -> isDragging', P.isDragging === true,
        'обработчик получил MouseEvent, а не функцию');

  await sleep(280);
  check('активация после 200 мс', P.isActiveMode === true);
  check('скорость стала 2.0', Math.abs(getRate() - 2.0) < 0.001, 'rate=' + getRate());
  check('HUD показан (opacity=1)', hudOpacity() === '1', 'opacity=' + hudOpacity());
  check('курсор скрыт на время жеста',
        window.document.body.style.cursor === 'none' || window.document.documentElement.style.cursor === 'none');

  // --- 2. Тяга вправо ---
  fireOn(v, 'mousemove', 600, 220, 1);
  await sleep(60);
  check('тянем вправо +240px -> 3.2', Math.abs(getRate() - 3.2) < 0.001, 'rate=' + getRate());

  // --- 3. Тяга вверх = фиксация ---
  fireOn(v, 'mousemove', 600, 120, 1);
  await sleep(60);
  check('тянем вверх -> lock', P.isSpeedLocked === true);

  // --- 4. Отпускание ---
  fireOn(v, 'mouseup', 600, 120, 0);
  await sleep(450);
  check('после отпускания скорость зафиксирована', Math.abs(getRate() - 3.2) < 0.001, 'rate=' + getRate());
  check('persistSpeed = 3.2', Math.abs((P.persistSpeed === null ? -1 : P.persistSpeed) - 3.2) < 0.001);
  check('режим управления выключился', P.isActiveMode === false);
  check('стили выделения сброшены',
        (window.document.body.style.userSelect || '') === '' && (window.document.body.style.cursor || '') === '');
  check('HUD скрыт (opacity=0)', hudOpacity() === '0', 'opacity=' + hudOpacity());

  // --- 5. Кнопка плеера не должна активировать жест ---
  const btn = window.document.createElement('button');
  btn.className = 'ytp-play-button';
  window.document.getElementById('player').appendChild(btn);
  btn.getBoundingClientRect = () => ({ left: 300, top: 300, right: 340, bottom: 340, width: 40, height: 40, x: 300, y: 300, toJSON() {} });
  const rateBeforeBtn = getRate();
  fireOn(btn, 'mousedown', 320, 320, 1);
  await sleep(280);
  check('кнопка плеера не активирует жест', P.isActiveMode === false, 'rate=' + getRate() + ' (было ' + rateBeforeBtn + ')');
  fireOn(btn, 'mouseup', 320, 320, 0);

  // --- 6. Текст рядом с видео не активирует и остаётся выделяемым ---
  const info = window.document.querySelector('.video_info');
  info.getBoundingClientRect = () => ({ left: 40, top: 500, right: 400, bottom: 540, width: 360, height: 40, x: 40, y: 500, toJSON() {} });
  fireOn(info, 'mousedown', 100, 520, 1);
  await sleep(280);
  check('текст рядом с видео не активирует', P.isActiveMode === false);
  check('выделение текста не отключено', (window.document.body.style.userSelect || '') === '');
  fireOn(info, 'mouseup', 100, 520, 0);

  // --- 7. Жест без фиксации возвращает 1.0 ---
  fireOn(v, 'mousedown', 360, 220, 1);
  await sleep(260);
  const mid = getRate();
  fireOn(v, 'mousemove', 500, 220, 1);
  await sleep(60);
  const dragged = getRate();
  fireOn(v, 'mouseup', 500, 220, 0);
  await sleep(250);
  check('обычный жест: 2.0 -> ' + dragged, Math.abs(mid - 2.0) < 0.001 && dragged > 2.0, 'mid=' + mid + ' drag=' + dragged);
  check('без фиксации скорость вернулась к 1.0', Math.abs(getRate() - 1.0) < 0.001, 'rate=' + getRate());

  // --- 8. Анти-залипание: потерянный mouseup (курсор ушёл за окно) ---
  fireOn(v, 'mousedown', 360, 220, 1);
  await sleep(260);
  check('залипание: жест активен', P.isActiveMode === true);
  fireOn(v, 'mousemove', 380, 220, 0); // buttons=0 -> кнопка уже отпущена
  await sleep(30);
  check('анти-залипание: перетаскивание сброшено сразу', P.isDragging === false);
  await sleep(200);
  check('анти-залипание: режим погас, скорость вернулась к 1.0',
        P.isActiveMode === false && Math.abs(getRate() - 1.0) < 0.001, 'rate=' + getRate());

  let failed = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : ''));
    if (!r.pass) failed++;
  }
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
