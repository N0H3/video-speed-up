# Политика конфиденциальности / Privacy Policy

**Video Speed Up** (далее — «Расширение»)

Последнее обновление: 13 ноября 2026 г.

## Кратко

Расширение **не собирает персональные данные**, не отслеживает пользователя и ничего никуда не отправляет.

## Какие данные используются

Расширение работает полностью локально в вашем браузере:

| Что | Где хранится | Зачем |
|---|---|---|
| Вкл/выкл (значение `isEnabled`) | `chrome.storage.sync` | Чтобы запомнить ваш выбор и синхронизировать его между вашими устройствами |

Больше ничего не сохраняется. Никакой истории просмотров, списков сайтов, cookies, идентификаторов
пользователя или активности вне видео.

## Передача данных

Расширение **не выполняет сетевых запросов** и **не отправляет** данные на серверы разработчика
или третьих лиц. В коде нет аналитики, трекеров, рекламных SDK и внешних скриптов.

## Доступ к страницам

Расширение подключается к страницам (`content_scripts` с `<all_urls>`), чтобы найти элемент
`<video>` и управлять его скоростью воспроизведения. Это необходимо для работы функции
ускорения. Содержимое страниц не читается, не записывается и не передаётся — изменяется только
свойство `playbackRate` видео-элемента.

Расширение не работает на страницах, открытых во внутренних браузерах приложений
(`chrome://`, страницы расширений, Google Web Store) — это ограничение платформы.

## Права пользователя

Вы можете в любой момент отключить Расширение (кнопка в popup или удаление расширения).
Удаление расширения также удаляет сохранённую настройку.

## Изменения политики

О любых изменениях этой политики будет сообщено в описании Расширения в Chrome Web Store
и в репозитории проекта.

## Контакты

Вопросы: https://github.com/ (репозиторий проекта) — или через страницу расширения в Chrome Web Store.

---

# Privacy Policy (English)

**Video Speed Up** does not collect, store, or transmit any personal data.

The extension stores a single setting — whether it is enabled or disabled — in `chrome.storage.sync`,
so that your choice persists and syncs across your devices. This value never leaves your browser.

The extension makes **no network requests** and contains no analytics, tracking, advertising SDKs,
or remote code. All functionality runs locally.

The extension injects a content script on all pages in order to locate `<video>` elements and adjust
their `playbackRate`. Page content is never read, stored, or transmitted; only the playback speed
of video elements is changed.

You can disable the extension at any time via the popup button or by removing it, which also
deletes the stored setting.
