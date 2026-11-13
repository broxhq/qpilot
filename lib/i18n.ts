// The UI follows the language the user writes in: a Russian test case produces a
// Russian run page. Model-written text (step descriptions, evidence, summary) is
// handled by the prompt — it simply answers in the language of the test case, so
// it works for any language. This module only covers the strings the app itself
// renders, which is why it is an explicit ru/en table rather than detection of
// every locale.

export type Lang = "ru" | "en";

/**
 * Cyrillic-vs-Latin ratio. Russian test cases are full of Latin (URLs, logins,
 * English UI labels), so a bare "more Cyrillic than Latin" test would misfire —
 * a small but non-trivial share of Cyrillic is the reliable signal.
 */
export function detectLanguage(text: string): Lang {
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const letters = cyrillic + latin;
  if (letters === 0) return "en";
  return cyrillic >= 10 && cyrillic / letters >= 0.1 ? "ru" : "en";
}

export interface Dict {
  back: string;
  newRun: string;
  notFound: string;
  steps: string;
  passedCount: string;
  warnCount: string;
  failedCount: string;
  waitingForPlan: string;
  noSteps: string;
  pause: string;
  resume: string;
  waitingToStart: string;
  endedBeforePlan: string;
  seeReason: string;
  summary: string;
  expected: string;
  actual: string;
  consoleErrors: string;
  mockUnverified: string;
  reviewerObjects: string;
  infoNewTab: string;
  infoTabClosed: string;
  infoDialog: string;
  infoAccepted: string;
  infoDismissed: string;
  statsModel: string;
  statsCalls: string;
  statsBrowser: string;
  statsVision: string;
  showReasoning: string;
  hideReasoning: string;
  copyReport: string;
  copied: string;
  downloadReport: string;
  runAgain: string;
  editAndRun: string;
  reportTitle: string;
  reportResult: string;
  reportDuration: string;
  reportScreenshot: string;
  testCase: string;
  attached: string;
  noEvents: string;
  runFinished: string;
  stepLabel: string;
  asking: string;
  userAnswered: string;
  needInput: string;
  submit: string;
  sending: string;
  secretPlaceholder: string;
  answerPlaceholder: string;
  status: Record<string, { label: string; sub: string }>;
  stepStatus: Record<string, string>;
  home: {
    tagline: string;
    chooseFolder: string;
    files: string;
    clearList: string;
    selectAll: string;
    selected: string;
    run: string;
    runN: string;
    withPreview: string;
    runPreview: string;
    running: string;
    stop: string;
    example: string;
    placeholder: string;
    batchRun: string;
    recentRuns: string;
    attach: string;
    addFile: string;
    attachHint: string;
    remove: string;
    settings: string;
  };
  settings: {
    title: string;
    back: string;
    model: string;
    provider: string;
    anthropic: string;
    custom: string;
    apiKey: string;
    apiToken: string;
    keySaved: string;
    keyFromEnv: string;
    keyRebind: string;
    modelLabel: string;
    modelHintAnthropic: string;
    modelHintCustom: string;
    baseUrl: string;
    baseUrlHintAnthropic: string;
    baseUrlHintCustom: string;
    optional: string;
    appearance: string;
    theme: string;
    themeSystem: string;
    themeLight: string;
    themeDark: string;
    save: string;
    saving: string;
    saved: string;
    storedIn: string;
    welcome: string;
    welcomeSub: string;
  };
  action: {
    opening: string;
    readingPage: string;
    looking: string;
    measuring: string;
    clickingAt: string;
    hoveringAt: string;
    readingBlock: string;
    clicking: string;
    clickingElement: string;
    filling: string;
    selecting: string;
    hovering: string;
    hoveringElement: string;
    scrollingTo: string;
    scrolling: string;
    inside: string;
    pressing: string;
    closingOverlay: string;
    waiting: string;
    askingUser: string;
    uploading: string;
    to: string;
    down: string;
    up: string;
    right: string;
    left: string;
    noting: string;
    waitingFor: string;
    waitingGone: string;
    switchingTab: string;
    nextDialog: string;
    dialogAccept: string;
    dialogDismiss: string;
    mocking: string;
    mockAbort: string;
    mockPatch: string;
    mockDelay: string;
    clearingMocks: string;
    goingOffline: string;
    goingOnline: string;
    readingRequests: string;
    readingConsole: string;
  };
}

const en: Dict = {
  back: "Back",
  newRun: "New run",
  notFound: "Run not found — it may have finished and been cleared from memory.",
  steps: "steps",
  passedCount: "passed",
  warnCount: "warn",
  failedCount: "failed",
  waitingForPlan: "waiting for plan…",
  noSteps: "no steps were run",
  pause: "Pause",
  resume: "Resume",
  waitingToStart: "waiting for agent to start…",
  endedBeforePlan: "The run ended before the agent produced a plan.",
  seeReason: "See the reason below.",
  summary: "Summary",
  expected: "Expected",
  actual: "Actual",
  consoleErrors: "Console errors during this step",
  reviewerObjects: "The agent passed this step, a second check disagrees",
  mockUnverified: "The mocked response was made up without a real one to compare with — its structure may not match what the page expects.",
  infoNewTab: "A new tab opened",
  infoTabClosed: "The tab was closed, back to",
  infoDialog: "Browser dialog",
  infoAccepted: "OK pressed",
  infoDismissed: "Cancel pressed",
  statsModel: "model",
  statsCalls: "calls",
  statsBrowser: "browser",
  statsVision: "sees screenshots",
  showReasoning: "Show agent reasoning",
  hideReasoning: "Hide agent reasoning",
  copyReport: "Copy report",
  copied: "Copied",
  downloadReport: "Download report",
  runAgain: "Run again",
  editAndRun: "Edit test case",
  reportTitle: "Test run report",
  reportResult: "Result",
  reportDuration: "Duration",
  reportScreenshot: "Screenshot",
  testCase: "Test case",
  attached: "Attached",
  noEvents: "no events for this step",
  runFinished: "Run finished",
  stepLabel: "Step",
  asking: "Asking",
  userAnswered: "User answered",
  needInput: "Agent needs input",
  submit: "Submit",
  sending: "Sending…",
  secretPlaceholder: "OTP / password",
  answerPlaceholder: "answer",
  status: {
    running: { label: "Running", sub: "agent is executing steps" },
    waiting: { label: "Waiting", sub: "agent needs your input" },
    paused: { label: "Paused", sub: "run is paused" },
    passed: { label: "Passed", sub: "all steps passed" },
    failed: { label: "Failed", sub: "some steps failed" },
    error: { label: "Error", sub: "agent crashed" },
  },
  home: {
    tagline: "Paste a test case. Watch it run.",
    chooseFolder: "Choose folder",
    files: "files",
    clearList: "Clear file list",
    selectAll: "Select all",
    selected: "selected",
    run: "Run",
    runN: "Run",
    withPreview: "With preview",
    runPreview: "Run with preview",
    running: "Running…",
    stop: "Stop",
    example: "Example",
    placeholder: "Paste your test case here…",
    batchRun: "Batch run",
    recentRuns: "Recent runs",
    attach: "Attach files",
    addFile: "Add file",
    attachHint: "optional — images, CSV or documents the test needs to upload",
    remove: "Remove",
    settings: "Settings",
  },
  stepStatus: {
    queued: "queued",
    pass: "pass",
    warn: "warn",
    fail: "fail",
    skipped: "skipped",
    running: "running",
  },
  settings: {
    title: "Settings",
    back: "Back",
    model: "Model",
    provider: "Provider",
    anthropic: "Anthropic (Claude)",
    custom: "OpenAI-compatible",
    apiKey: "Anthropic API key",
    apiToken: "API token",
    keySaved: "Saved key {hint} — leave empty to keep it",
    keyFromEnv: "Using {hint} from the environment — leave empty to keep it",
    keyRebind: "Re-enter the key for this address — the saved key is only sent to the base URL it was saved with",
    modelLabel: "Model",
    modelHintAnthropic: "Model id. Leave empty for the default: {model}.",
    modelHintCustom: "Model id exactly as the endpoint names it. The model must support tool calling.",
    baseUrl: "Base URL",
    baseUrlHintAnthropic: "Only to reach Claude through a corporate proxy. Leave empty for api.anthropic.com.",
    baseUrlHintCustom: "The endpoint's OpenAI-compatible root, usually ending in /v1.",
    optional: "optional",
    appearance: "Appearance",
    theme: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    save: "Save",
    saving: "Saving…",
    saved: "Saved",
    storedIn: "Stored in {path}",
    welcome: "Connect a model to get started",
    welcomeSub: "qpilot drives the browser with an AI model. Add your API key below — you can change it here any time.",
  },
  action: {
    opening: "Opening",
    readingPage: "Reading page",
    looking: "Looking at the page",
    measuring: "Measuring elements:",
    clickingAt: "Clicking at",
    hoveringAt: "Hovering at",
    readingBlock: "Reading block",
    clicking: "Clicking",
    clickingElement: "Clicking element",
    filling: "Filling",
    selecting: "Selecting",
    hovering: "Hovering",
    hoveringElement: "Hovering element",
    scrollingTo: "Scrolling to",
    scrolling: "Scrolling",
    inside: "inside",
    pressing: "Pressing",
    closingOverlay: "Closing overlay",
    waiting: "Waiting",
    askingUser: "Asking user",
    uploading: "Uploading",
    to: "to",
    down: "down",
    up: "up",
    right: "right",
    left: "left",
    noting: "Noting:",
    waitingFor: "Waiting for",
    waitingGone: "Waiting until it disappears:",
    switchingTab: "Switching to tab",
    nextDialog: "Next dialog:",
    dialogAccept: "OK",
    dialogDismiss: "Cancel",
    mocking: "Mocking",
    mockAbort: "network error",
    mockPatch: "patch the real response",
    mockDelay: "delay",
    clearingMocks: "Removing mocks",
    goingOffline: "Turning the network off",
    goingOnline: "Turning the network on",
    readingRequests: "Reading network requests",
    readingConsole: "Reading console errors",
  },
};

const ru: Dict = {
  back: "Назад",
  newRun: "Новый прогон",
  notFound: "Прогон не найден — возможно, он завершился и был вытеснен из памяти.",
  steps: "шагов",
  passedCount: "успешно",
  warnCount: "предупреждений",
  failedCount: "провалено",
  waitingForPlan: "ждём план…",
  noSteps: "шаги не выполнялись",
  pause: "Пауза",
  resume: "Продолжить",
  waitingToStart: "ждём запуска агента…",
  endedBeforePlan: "Прогон завершился до того, как агент составил план.",
  seeReason: "Причина — ниже.",
  summary: "Итог",
  expected: "Ожидалось",
  actual: "Фактически",
  consoleErrors: "Ошибки в консоли на этом шаге",
  reviewerObjects: "Агент засчитал шаг, повторная проверка не согласна",
  mockUnverified: "Подменённый ответ придуман без сверки с настоящим — его структура может не совпадать с тем, что ждёт страница.",
  infoNewTab: "Открылась новая вкладка",
  infoTabClosed: "Вкладка закрыта, возврат на",
  infoDialog: "Диалог браузера",
  infoAccepted: "нажато OK",
  infoDismissed: "нажата «Отмена»",
  statsModel: "модель",
  statsCalls: "вызовов",
  statsBrowser: "браузер",
  statsVision: "видит скриншоты",
  showReasoning: "Показать рассуждения агента",
  hideReasoning: "Скрыть рассуждения агента",
  copyReport: "Скопировать отчёт",
  copied: "Скопировано",
  downloadReport: "Скачать отчёт",
  runAgain: "Запустить снова",
  editAndRun: "Изменить кейс",
  reportTitle: "Отчёт о прогоне",
  reportResult: "Результат",
  reportDuration: "Длительность",
  reportScreenshot: "Скриншот",
  testCase: "Тест-кейс",
  attached: "Вложения",
  noEvents: "событий по этому шагу нет",
  runFinished: "Прогон завершён",
  stepLabel: "Шаг",
  asking: "Спрашивает",
  userAnswered: "Пользователь ответил",
  needInput: "Агенту нужен ввод",
  submit: "Отправить",
  sending: "Отправка…",
  secretPlaceholder: "код / пароль",
  answerPlaceholder: "ответ",
  status: {
    running: { label: "Выполняется", sub: "агент проходит шаги" },
    waiting: { label: "Ожидание", sub: "агенту нужен ваш ввод" },
    paused: { label: "Пауза", sub: "прогон приостановлен" },
    passed: { label: "Успешно", sub: "все шаги пройдены" },
    failed: { label: "Провален", sub: "часть шагов не прошла" },
    error: { label: "Ошибка", sub: "агент упал" },
  },
  home: {
    tagline: "Вставьте тест-кейс. Смотрите, как он проходит.",
    chooseFolder: "Выбрать папку",
    files: "файлов",
    clearList: "Очистить список",
    selectAll: "Выбрать все",
    selected: "выбрано",
    run: "Запустить",
    runN: "Запустить",
    withPreview: "С превью",
    runPreview: "Запустить с превью",
    running: "Запускаем…",
    stop: "Остановить",
    example: "Пример",
    placeholder: "Вставьте сюда свой тест-кейс…",
    batchRun: "Пакетный прогон",
    recentRuns: "Последние прогоны",
    attach: "Прикрепить файлы",
    addFile: "Добавить файл",
    attachHint: "необязательно — картинки, CSV или документы, которые нужно загрузить в тесте",
    remove: "Убрать",
    settings: "Настройки",
  },
  stepStatus: {
    queued: "в очереди",
    pass: "успех",
    warn: "внимание",
    fail: "провал",
    skipped: "пропущен",
    running: "выполняется",
  },
  settings: {
    title: "Настройки",
    back: "Назад",
    model: "Модель",
    provider: "Провайдер",
    anthropic: "Anthropic (Claude)",
    custom: "OpenAI-совместимый",
    apiKey: "API-ключ Anthropic",
    apiToken: "API-токен",
    keySaved: "Сохранён ключ {hint} — оставьте пустым, чтобы не менять",
    keyFromEnv: "Используется {hint} из переменных окружения — оставьте пустым, чтобы не менять",
    keyRebind: "Введите ключ заново для этого адреса — сохранённый ключ отправляется только на тот Base URL, с которым его сохранили",
    modelLabel: "Модель",
    modelHintAnthropic: "Идентификатор модели. Оставьте пустым для модели по умолчанию: {model}.",
    modelHintCustom: "Идентификатор модели, как он назван на сервере. Модель должна поддерживать tool calling.",
    baseUrl: "Base URL",
    baseUrlHintAnthropic: "Только для доступа к Claude через корпоративный прокси. Оставьте пустым для api.anthropic.com.",
    baseUrlHintCustom: "Корень OpenAI-совместимого API, обычно заканчивается на /v1.",
    optional: "необязательно",
    appearance: "Внешний вид",
    theme: "Тема",
    themeSystem: "Системная",
    themeLight: "Светлая",
    themeDark: "Тёмная",
    save: "Сохранить",
    saving: "Сохраняю…",
    saved: "Сохранено",
    storedIn: "Хранится в {path}",
    welcome: "Подключите модель, чтобы начать",
    welcomeSub: "qpilot управляет браузером с помощью ИИ-модели. Укажите API-ключ ниже — поменять его можно здесь в любой момент.",
  },
  action: {
    opening: "Открывает",
    readingPage: "Читает страницу",
    looking: "Смотрит на страницу",
    measuring: "Измеряет элементы:",
    clickingAt: "Кликает в точку",
    hoveringAt: "Наводит на точку",
    readingBlock: "Читает блок",
    clicking: "Кликает",
    clickingElement: "Кликает по элементу",
    filling: "Заполняет",
    selecting: "Выбирает",
    hovering: "Наводит на",
    hoveringElement: "Наводит на элемент",
    scrollingTo: "Скроллит к",
    scrolling: "Скроллит",
    inside: "внутри",
    pressing: "Нажимает",
    closingOverlay: "Закрывает оверлей",
    waiting: "Ждёт",
    askingUser: "Спрашивает пользователя",
    uploading: "Загружает",
    to: "в",
    down: "вниз",
    up: "вверх",
    right: "вправо",
    left: "влево",
    noting: "Запоминает:",
    waitingFor: "Ждёт появления",
    waitingGone: "Ждёт, пока исчезнет:",
    switchingTab: "Переключение на вкладку",
    nextDialog: "Следующий диалог:",
    dialogAccept: "OK",
    dialogDismiss: "Отмена",
    mocking: "Подмена запроса",
    mockAbort: "сетевая ошибка",
    mockPatch: "правка настоящего ответа",
    mockDelay: "задержка",
    clearingMocks: "Снятие подмен",
    goingOffline: "Отключение сети",
    goingOnline: "Включение сети",
    readingRequests: "Чтение сетевых запросов",
    readingConsole: "Чтение ошибок консоли",
  },
};

export const DICTS: Record<Lang, Dict> = { en, ru };

export function dict(lang: Lang | undefined): Dict {
  return DICTS[lang ?? "en"] ?? en;
}
