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
  },
  stepStatus: {
    queued: "queued",
    pass: "pass",
    warn: "warn",
    fail: "fail",
    skipped: "skipped",
    running: "running",
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
  },
  stepStatus: {
    queued: "в очереди",
    pass: "успех",
    warn: "внимание",
    fail: "провал",
    skipped: "пропущен",
    running: "выполняется",
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
