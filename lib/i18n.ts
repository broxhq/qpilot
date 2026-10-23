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
    uploadMd: string;
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
    expand: string;
    collapse: string;
    batchRun: string;
    recentRuns: string;
    attach: string;
    addFile: string;
    attachHint: string;
    remove: string;
    settings: string;
    gitRepos: string;
    addRepo: string;
    noRepos: string;
    confirmRemoveRepo: string;
    syncRepo: string;
    updatedAt: string;
    noMdFiles: string;
    repoUrl: string;
    repoUrlHint: string;
    branch: string;
    branchHint: string;
    folder: string;
    folderHint: string;
    token: string;
    tokenHint: string;
    username: string;
    usernameHint: string;
    optional: string;
    cancel: string;
    connect: string;
    connecting: string;
    switchBranch: string;
    branchSearch: string;
    branchesLoading: string;
    noBranches: string;
    branchDefault: string;
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
    modelsLoading: string;
    modelsNeedKey: string;
    refreshModels: string;
    modelSearch: string;
    noModels: string;
    useTyped: string;
    chooseModel: string;
    defaultTag: string;
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
    uploadMd: "Upload .md",
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
    expand: "Expand",
    collapse: "Collapse",
    batchRun: "Batch run",
    recentRuns: "Recent runs",
    attach: "Attach files",
    addFile: "Add file",
    attachHint: "optional — images, CSV or documents the test needs to upload",
    remove: "Remove",
    settings: "Settings",
    gitRepos: "Git repositories",
    addRepo: "Connect repository",
    noRepos: "No repositories connected yet",
    confirmRemoveRepo: "Remove {name} from qpilot? Only the local copy is deleted — the repository itself is not touched.",
    syncRepo: "Pull latest changes",
    updatedAt: "updated",
    noMdFiles: "No .md files in this repository",
    repoUrl: "Repository URL",
    repoUrlHint: "HTTPS or SSH, e.g. https://github.com/team/tests.git or git@github.com:team/tests.git",
    branch: "Branch",
    branchHint: "empty = default branch",
    folder: "Test cases folder",
    folderHint: "empty = whole repository",
    token: "Access token",
    tokenHint: "only for a private repository over HTTPS — an SSH URL uses your SSH key instead",
    username: "Username",
    usernameHint: "only if your Git host needs it together with the token (e.g. Bitbucket)",
    optional: "optional",
    cancel: "Cancel",
    connect: "Connect",
    connecting: "Cloning…",
    switchBranch: "Switch branch",
    branchSearch: "Find a branch…",
    branchesLoading: "Loading branches…",
    noBranches: "No matching branches",
    branchDefault: "default",
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
    modelHintAnthropic: "Loaded live from Anthropic: every model your key can use.",
    modelHintCustom: "Loaded from the endpoint's /models list. The model must support tool calling.",
    modelsLoading: "Loading models…",
    modelsNeedKey: "Enter the API key to load the models",
    refreshModels: "Reload the list",
    modelSearch: "Find a model or type its id…",
    noModels: "No matching models",
    useTyped: "Use “{id}”",
    chooseModel: "Choose a model",
    defaultTag: "default",
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
    uploadMd: "Загрузить .md",
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
    expand: "Развернуть",
    collapse: "Свернуть",
    batchRun: "Пакетный прогон",
    recentRuns: "Последние прогоны",
    attach: "Прикрепить файлы",
    addFile: "Добавить файл",
    attachHint: "необязательно — картинки, CSV или документы, которые нужно загрузить в тесте",
    remove: "Убрать",
    settings: "Настройки",
    gitRepos: "Git-репозитории",
    addRepo: "Подключить репозиторий",
    noRepos: "Пока нет подключённых репозиториев",
    confirmRemoveRepo: "Убрать {name} из qpilot? Удалится только локальная копия — сам репозиторий не изменится.",
    syncRepo: "Подтянуть последние изменения",
    updatedAt: "обновлено",
    noMdFiles: "В репозитории нет .md-файлов",
    repoUrl: "Адрес репозитория",
    repoUrlHint: "HTTPS или SSH, например https://github.com/team/tests.git или git@github.com:team/tests.git",
    branch: "Ветка",
    branchHint: "пусто — основная ветка",
    folder: "Папка с тестами",
    folderHint: "пусто — весь репозиторий",
    token: "Токен доступа",
    tokenHint: "только для приватного репозитория по HTTPS — SSH-адрес использует ваш SSH-ключ",
    username: "Имя пользователя",
    usernameHint: "только если Git-хостинг требует его вместе с токеном (например, Bitbucket)",
    optional: "необязательно",
    cancel: "Отмена",
    connect: "Подключить",
    connecting: "Клонирую…",
    switchBranch: "Сменить ветку",
    branchSearch: "Найти ветку…",
    branchesLoading: "Загружаю ветки…",
    noBranches: "Подходящих веток нет",
    branchDefault: "основная",
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
    modelHintAnthropic: "Список загружается из Anthropic: все модели, доступные вашему ключу.",
    modelHintCustom: "Список берётся из /models на сервере. Модель должна поддерживать tool calling.",
    modelsLoading: "Загружаю модели…",
    modelsNeedKey: "Введите API-ключ, чтобы загрузить модели",
    refreshModels: "Обновить список",
    modelSearch: "Найти модель или ввести её ID…",
    noModels: "Подходящих моделей нет",
    useTyped: "Использовать «{id}»",
    chooseModel: "Выберите модель",
    defaultTag: "по умолчанию",
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
  },
};

export const DICTS: Record<Lang, Dict> = { en, ru };

export function dict(lang: Lang | undefined): Dict {
  return DICTS[lang ?? "en"] ?? en;
}
