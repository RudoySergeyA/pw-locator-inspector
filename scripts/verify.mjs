import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, '..');

const coreBundleOut = path.join(extensionRoot, 'dist', 'core-test-bundle.cjs');
await esbuild.build({
  stdin: {
    contents: `
      export * from './src/workspacePlaywright';
      export * from './src/locatorAstResolver';
      export * from './src/browserManager';
      export * from './src/webviewPanel';
      export * from './src/extension';
    `,
    resolveDir: extensionRoot,
    loader: 'ts',
  },
  bundle: true,
  external: ['vscode'],
  outfile: coreBundleOut,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
});

const require = createRequire(import.meta.url);
const Module = require('node:module');
const origLoad = Module._load;
const vscodeMock = {
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  MarkdownString: class { constructor(value) { this.value = value; } },
  Uri: { parse: (value) => value },
  DecorationRangeBehavior: undefined,
  ColorThemeKind: undefined,
  Disposable: undefined,
  workspace: undefined,
  window: undefined,
  commands: undefined,
  ViewColumn: { Two: 2 },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
};
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return origLoad.apply(this, arguments);
};

const {
  resolveWorkspacePlaywright,
  loadPlaywrightConfigSettings,
  discoverStorageStateFiles,
  isValidPlaywrightStorageStateFile,
  isSensitiveEnvKey,
  isSensitiveHeaderName,
  sanitizeBaseUrl,
  resolveLocatorAtPosition,
  resolveLocatorAtPositionWithCounts,
  resolveLocatorFromSnippet,
  collectFileLocators,
  collectFileLocatorsWithCounts,
  MissingLoopCountError,
  materializeLocator,
  BrowserManager,
  BrowserWebviewPanel,
  activate,
  deactivate,
} = require(coreBundleOut);
Module._load = origLoad;

const loopSource = [
  'class CardsPage {',
  '  check() {',
  '    const expected = { cards: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }] };',
  '    for (let i = 0; i < expected.cards.length; i++) {',
  '      const cardData = expected.cards[i];',
  '      const image = page.getByTestId("card").nth(i).getByRole("img", { name: cardData.title });',
  '      expect(image).toBeVisible();',
  '    }',
  '  }',
  '}',
].join('\n');
const loopFilePath = path.join(extensionRoot, 'cards.spec.ts');
const loopSelection = { startLine: 6, endLine: 6, startColumn: 13, endColumn: 18 };
const loopDescriptor = resolveLocatorAtPosition({
  filePath: loopFilePath, sourceText: loopSource, line: 6, column: 18, selection: loopSelection,
}).descriptor;
assert.deepEqual(loopDescriptor?.iterations?.map(({ steps }) => steps.slice(-2).map(({ args }) => args)), [
  [[0], ['img', { name: 'Alpha' }]],
  [[1], ['img', { name: 'Beta' }]],
  [[2], ['img', { name: 'Gamma' }]],
]);
assert.deepEqual(resolveLocatorAtPosition({
  filePath: loopFilePath, sourceText: loopSource, line: 7, column: 16,
}).descriptor, loopDescriptor);

const countLoopSource = [
  'class ConstructorComponent {',
  '  readonly page: Page;',
  '  readonly dishes: { root: Locator; cards: Locator };',
  '  constructor(page: Page) {',
  '    this.page = page;',
  '    this.dishes = {',
  '      root: this.page.getByTestId("dishes"),',
  '      cards: this.page.getByTestId("dishes").locator(".card"),',
  '    };',
  '  }',
  '  async assertDishesElementsVisible(flag: boolean) {',
  '    const dishesCardCount = await this.dishes.cards.count();',
  '    if (flag) {',
  '      for (let i = 0; i < dishesCardCount; i++) {',
  '        const card = this.dishes.cards.nth(i);',
  '        const dishImage = card.locator("img");',
  '        if ((await dishImage.count()) > 0) {',
  '          await expect(dishImage).toBeVisible();',
  '        }',
  '      }',
  '    }',
  '    for (let j = 0; j < Math.min(await this.dishes.cards.count(), 2); j++) {',
  '      const shortCard = this.dishes.cards.nth(j);',
  '    }',
  '    for (let k = dishesCardCount - 1; k >= 0; k--) {',
  '      const revCard = this.dishes.cards.nth(k);',
  '    }',
  '  }',
  '}',
].join('\n');
const countLoopFilePath = path.join(extensionRoot, 'ConstructorComponent.ts');
assert.throws(
  () => resolveLocatorAtPosition({ filePath: countLoopFilePath, sourceText: countLoopSource, line: 15, column: 15 }),
  (err) => err instanceof MissingLoopCountError &&
    err.countDescriptors.length === 1 &&
    err.countDescriptors[0].humanReadable === 'page.getByTestId("dishes").locator(".card")'
);
let countProbeCalls = 0;
const resolvedCardInLoop = await resolveLocatorAtPositionWithCounts({
  filePath: countLoopFilePath,
  sourceText: countLoopSource,
  line: 15,
  column: 15,
  resolveCount: async (desc) => {
    countProbeCalls += 1;
    return desc.humanReadable === 'page.getByTestId("dishes").locator(".card")' ? 3 : undefined;
  },
});
assert.equal(countProbeCalls, 1);
assert.deepEqual(
  resolvedCardInLoop.descriptor?.iterations?.map((d) => d.humanReadable),
  [
    'page.getByTestId("dishes").locator(".card").nth(0)',
    'page.getByTestId("dishes").locator(".card").nth(1)',
    'page.getByTestId("dishes").locator(".card").nth(2)',
  ]
);
const resolvedDishImage = await resolveLocatorAtPositionWithCounts({
  filePath: countLoopFilePath,
  sourceText: countLoopSource,
  line: 16,
  column: 15,
  resolveCount: async () => 3,
});
assert.deepEqual(
  resolvedDishImage.descriptor?.iterations?.map((d) => d.humanReadable),
  [
    'page.getByTestId("dishes").locator(".card").nth(0).locator("img")',
    'page.getByTestId("dishes").locator(".card").nth(1).locator("img")',
    'page.getByTestId("dishes").locator(".card").nth(2).locator("img")',
  ]
);
const collectedCountLoop = await collectFileLocatorsWithCounts({
  filePath: countLoopFilePath,
  sourceText: countLoopSource,
  resolveCount: async () => 3,
});
assert.ok(collectedCountLoop.some((item) => item.line === 15 && item.descriptor?.iterations?.length === 3));
assert.ok(collectedCountLoop.some((item) => item.line === 16 && item.descriptor?.iterations?.length === 3));
assert.ok(collectedCountLoop.some((item) => item.line === 18 && item.descriptor?.iterations?.length === 3));
assert.ok(collectedCountLoop.some((item) => item.line === 23 && item.descriptor?.iterations?.length === 2));
assert.deepEqual(
  collectedCountLoop.find((item) => item.line === 26)?.descriptor?.iterations?.map((d) => d.steps.at(-1)?.args),
  [[2], [1], [0]]
);

const nestedCountSource = [
  'async function checkTable(page: Page) {',
  '  const rows = page.locator("tr");',
  '  const rowCount = await rows.count();',
  '  for (let i = 0; i < rowCount; i++) {',
  '    const cellCount = await rows.nth(i).locator("td").count();',
  '    for (let j = 0; j < cellCount; j++) {',
  '      const cell = rows.nth(i).locator("td").nth(j);',
  '    }',
  '  }',
  '}',
].join('\n');
const resolvedNestedCell = await resolveLocatorAtPositionWithCounts({
  filePath: path.join(extensionRoot, 'table.spec.ts'),
  sourceText: nestedCountSource,
  line: 7,
  column: 13,
  resolveCount: async (desc) => {
    if (desc.humanReadable === 'page.locator("tr")') return 2;
    if (desc.humanReadable === 'page.locator("tr").nth(0).locator("td")') return 2;
    if (desc.humanReadable === 'page.locator("tr").nth(1).locator("td")') return 1;
    return undefined;
  },
});
assert.deepEqual(
  resolvedNestedCell.descriptor?.iterations?.map((d) => d.humanReadable),
  [
    'page.locator("tr").nth(0).locator("td").nth(0)',
    'page.locator("tr").nth(0).locator("td").nth(1)',
    'page.locator("tr").nth(1).locator("td").nth(0)',
  ]
);

const nullishSource = [
  'const REVIEWS_CONSTANT = { defaultTitle: "Отзывы клиентов" };',
  'class ReviewComponent {',
  '  readonly page: Page;',
  '  readonly reviewsConstant = REVIEWS_CONSTANT;',
  '  readonly expectedTitle: string;',
  '  readonly root: Locator;',
  '  readonly title: Locator;',
  '  readonly altRoot: Locator;',
  '  constructor(page: Page, isMobile?: boolean, options?: { root?: Locator; title?: string }, fallbackRoot?: Locator) {',
  '    this.page = page;',
  '    this.expectedTitle = options?.title ?? this.reviewsConstant.defaultTitle;',
  '    this.root = options?.root ?? this.page.locator("section", { hasText: this.expectedTitle });',
  '    this.title = this.root.getByRole("heading", { level: 2 });',
  '    this.altRoot = fallbackRoot || this.page.getByTestId(isMobile ? "m-root" : "d-root");',
  '  }',
  '}',
].join('\n');
const nullishFilePath = path.join(extensionRoot, 'reviewComponent.ts');
const resolvedTitle = resolveLocatorAtPosition({
  filePath: nullishFilePath, sourceText: nullishSource, line: 13, column: 20,
});
assert.deepEqual(resolvedTitle.descriptor?.steps, [
  { method: 'locator', args: ['section', { hasText: 'Отзывы клиентов' }] },
  { method: 'getByRole', args: ['heading', { level: 2 }] },
]);
const resolvedAltRoot = resolveLocatorAtPosition({
  filePath: nullishFilePath, sourceText: nullishSource, line: 14, column: 20,
});
assert.deepEqual(resolvedAltRoot.descriptor?.steps, [
  { method: 'getByTestId', args: ['d-root'] },
]);
const collectedNullish = collectFileLocators({
  filePath: nullishFilePath, sourceText: nullishSource,
});
assert.equal(collectedNullish.length, 3);

const subclassSource = [
  nullishSource,
  'class B2bReviewComponent extends ReviewComponent {',
  '  constructor(page: Page, isMobile?: boolean) {',
  '    super(page, isMobile, { root: page.getByTestId("b2b-reviews"), title: "Отзывы" });',
  '  }',
  '}',
].join('\n');
const resolvedWithSub = resolveLocatorAtPosition({
  filePath: nullishFilePath, sourceText: subclassSource, line: 13, column: 20,
});
assert.equal(resolvedWithSub.requiresParameterSelection, true);
assert.equal(resolvedWithSub.variantKind, 'context');
assert.deepEqual(resolvedWithSub.parameterNames, ['Context']);
assert.deepEqual(
  resolvedWithSub.variants.map((v) => [v.id, v.descriptor.humanReadable]),
  [
    ['ReviewComponent', 'page.locator("section", { hasText: "Отзывы клиентов" }).getByRole("heading", { level: 2 })'],
    ['B2bReviewComponent', 'page.getByTestId("b2b-reviews").getByRole("heading", { level: 2 })'],
  ]
);

async function verifySearchErrorClearsHighlight() {
  const noopEvent = () => ({ dispose() {} });
  const commands = new Map();
  const subscriptions = [];
  const postedMessages = [];
  const shownErrors = [];
  let receiveMessage;
  let closePanel;
  const line = 'page.getByTestId("ok")';
  const editor = {
    document: {
      uri: { scheme: 'file', fsPath: path.join(extensionRoot, 'searchError.spec.ts'), toString: () => 'searchError.spec.ts' },
      getText: () => line,
      lineCount: 1,
      lineAt: () => ({ range: { end: { line: 0, character: line.length } } }),
    },
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: line.length }, active: { line: 0, character: 0 }, isEmpty: false },
    setDecorations() {},
  };
  const savedVscode = {
    DecorationRangeBehavior: vscodeMock.DecorationRangeBehavior,
    ColorThemeKind: vscodeMock.ColorThemeKind,
    Disposable: vscodeMock.Disposable,
    workspace: vscodeMock.workspace,
    window: vscodeMock.window,
    commands: vscodeMock.commands,
  };
  Object.assign(vscodeMock, {
    DecorationRangeBehavior: { ClosedClosed: 0 },
    ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    workspace: {
      onDidChangeTextDocument: noopEvent,
      getWorkspaceFolder: () => ({ uri: editor.document.uri }),
      getConfiguration: () => ({ get: () => undefined }),
    },
    window: {
      activeTextEditor: editor,
      visibleTextEditors: [editor],
      activeColorTheme: { kind: 1 },
      onDidChangeActiveTextEditor: noopEvent,
      onDidChangeTextEditorSelection: noopEvent,
      createTextEditorDecorationType: noopEvent,
      createWebviewPanel: () => ({
        visible: true,
        webview: {
          onDidReceiveMessage(listener) { receiveMessage = listener; },
          postMessage(message) { postedMessages.push(message); },
        },
        onDidDispose(listener) { closePanel = listener; },
      }),
      setStatusBarMessage() {},
      showWarningMessage() {},
      showErrorMessage(message) { shownErrors.push(message); },
    },
    commands: {
      registerCommand: (id, command) => { commands.set(id, command); return noopEvent(); },
    },
  });
  const origEnsureStarted = BrowserManager.prototype.ensureStarted;
  const origClear = BrowserManager.prototype.clearHighlight;
  const clearCalls = [];
  BrowserManager.prototype.ensureStarted = async function () {};
  BrowserManager.prototype.clearHighlight = async function (resetState = false) {
    clearCalls.push(resetState);
    return origClear.call(this, resetState);
  };
  try {
    activate({
      subscriptions,
      workspaceState: { get: (_k, d) => d, update: async () => {} },
      extensionPath: path.join(extensionRoot, 'tmp-ext'),
      extension: { id: 'inspector.test' },
    });
    await commands.get('pwLocatorInspector.showLocator')();
    postedMessages.length = 0;
    clearCalls.length = 0;
    await receiveMessage({ type: 'searchLocatorSnippet', snippet: 'ааыаываыва ыа ываыа ыва' });
    assert.deepEqual(clearCalls, [true]);
    assert.ok(shownErrors.some((m) => m.includes('Failed to parse or resolve Playwright locator')));
    const stateIdx = postedMessages.findIndex((m) => m.type === 'state' && m.payload?.lastHighlight === undefined);
    const errIdx = postedMessages.findIndex((m) => m.type === 'searchError');
    assert.ok(stateIdx !== -1 && errIdx !== -1 && stateIdx < errIdx);
  } finally {
    BrowserManager.prototype.ensureStarted = origEnsureStarted;
    BrowserManager.prototype.clearHighlight = origClear;
    subscriptions.forEach((s) => s.dispose());
    await deactivate();
    closePanel?.();
    Object.assign(vscodeMock, savedVscode);
  }
}
await verifySearchErrorClearsHighlight();

async function verifySelectionBadge(filePath, url) {
  const lines = ['page.locator(\'meta[name="description"]\')', 'page.getByRole("button", { name: "Mobile menu" })'];
  const start = { line: 0, character: 0 };
  const end = { line: 0, character: lines[0].length };
  const selectionListeners = [];
  const commands = new Map();
  const subscriptions = [];
  const noopEvent = () => ({ dispose() {} });
  let badge = '';
  let mobileGutter;
  let badgeChanged;
  let receiveMessage;
  let closePanel;
  let highlightedCount;
  let inspectedUrl;
  let highlightStatus;
  let history = [];
  const storedHistory = new Map();
  const editor = {
    document: {
      uri: { scheme: 'file', fsPath: filePath, toString: () => filePath },
      getText: (range) => range ? lines[range.start.line] : lines.join('\n'),
      lineCount: lines.length,
      lineAt: (line) => ({ range: { end: { line, character: lines[line].length } } }),
    },
    selection: { start, end, active: end, isEmpty: false },
    setDecorations(_type, items) {
      const label = items[0]?.renderOptions?.after?.contentText?.trim();
      if (label !== undefined) {
        badge = label;
        badgeChanged?.();
      }
      const mobileStatus = items.find((item) => item.range?.start?.line === 1)?.hoverMessage?.value;
      if (mobileStatus) {
        mobileGutter = mobileStatus.includes('**Found: 1**') ? 1 : 0;
        badgeChanged?.();
      }
    },
  };
  const waitForBadge = (expected, expectedHighlight, expectedGutter) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Ожидался бейдж «${expected}», получен «${badge}»; совпадений в панели: ${highlightedCount}`
    )), 3000);
    badgeChanged = () => {
      if (badge === expected && (expectedHighlight === undefined || highlightedCount === expectedHighlight) &&
          (expectedGutter === undefined || mobileGutter === expectedGutter)) {
        clearTimeout(timer);
        resolve();
      }
    };
    badgeChanged();
  });
  Object.assign(vscodeMock, {
    DecorationRangeBehavior: { ClosedClosed: 0 },
    ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    workspace: {
      onDidChangeTextDocument: noopEvent,
      getWorkspaceFolder: () => ({ uri: editor.document.uri }),
      getConfiguration: () => ({ get: (key) => key === 'defaultUrl' ? url : undefined }),
    },
    window: {
      activeTextEditor: editor,
      visibleTextEditors: [editor],
      activeColorTheme: { kind: 1 },
      onDidChangeActiveTextEditor: noopEvent,
      onDidChangeTextEditorSelection: (listener) => { selectionListeners.push(listener); return noopEvent(); },
      createTextEditorDecorationType: noopEvent,
      createWebviewPanel: () => ({
        visible: true,
        webview: {
          onDidReceiveMessage(listener) { receiveMessage = listener; },
          postMessage(message) {
            if (message.type === 'state') inspectedUrl = message.payload.currentUrl;
            if (message.type === 'navigationHistory') history = message.payload.urls;
            if (message.type === 'highlightResult') {
              highlightStatus = message.payload.statusText;
              highlightedCount = message.payload.count;
              badgeChanged?.();
            }
          },
        },
        onDidDispose(listener) { closePanel = listener; },
      }),
      setStatusBarMessage() {},
      showErrorMessage: (message) => { throw new Error(message); },
    },
    commands: {
      registerCommand: (id, command) => { commands.set(id, command); return noopEvent(); },
    },
  });
  try {
    activate({ subscriptions, workspaceState: {
      get: (key, fallback) => storedHistory.get(key) ?? fallback,
      update: async (key, value) => { storedHistory.set(key, value); },
    }, extensionPath: path.join(filePath, 'uninstalled', 'extension'), extension: { id: 'inspector.test' } });
    selectionListeners.forEach((listener) => listener({ textEditor: editor }));
    await waitForBadge('Inspector browser is closed');
    await commands.get('pwLocatorInspector.showLocator')();
    assert.equal(inspectedUrl, 'about:blank');
    assert.equal(highlightStatus, 'Waiting for page');
    assert.equal(mobileGutter, undefined);
    assert.equal(badge, 'Inspector browser is closed'); // Заглушка не фиксирует снятие декорации.
    assert.deepEqual(history, []);

    // Webview получает фокус, а VS Code может оставить активным другой редактор.
    const otherEditor = { ...editor, selection: { start, end: start, active: start, isEmpty: true } };
    vscodeMock.window.activeTextEditor = otherEditor;
    vscodeMock.window.visibleTextEditors = [otherEditor, editor];
    await receiveMessage({ type: 'navigate', url });
    await waitForBadge('Found in DOM: 1 (visible: 0)', 1);
    assert.equal(inspectedUrl, url);

    const mobileStart = { line: 1, character: 0 };
    const mobileEnd = { line: 1, character: lines[1].length };
    editor.selection = { start: mobileStart, end: mobileEnd, active: mobileEnd, isEmpty: false };
    selectionListeners.forEach((listener) => listener({ textEditor: editor }));
    vscodeMock.window.activeTextEditor = editor;
    await commands.get('pwLocatorInspector.showLocator')();
    vscodeMock.window.activeTextEditor = otherEditor;
    await waitForBadge('Found in DOM: 0 (not on current page)', 0, 0);
    await receiveMessage({ type: 'setViewport', width: 393, height: 851 });
    await waitForBadge('Found in DOM: 1 (visible: 1)', 1, 1);
    // На открытой странице кнопка появляется и исчезает без смены фокуса.
    await receiveMessage({ type: 'navigate', url: `${url}?toggle=1` });
    await waitForBadge('Found in DOM: 0 (not on current page)', undefined, 0);
    await waitForBadge('Found in DOM: 1 (visible: 1)', undefined, 1);
    await waitForBadge('Found in DOM: 0 (not on current page)', undefined, 0);
    await receiveMessage({ type: 'setViewport', width: 1440, height: 900 });
    await waitForBadge('Found in DOM: 0 (not on current page)', 0, 0);

    const origin = new URL(url).origin;
    await receiveMessage({ type: 'navigate', url: `${origin}/redirect` });
    assert.deepEqual(history, [`${origin}/other`, `${origin}/redirect`, `${url}?toggle=1`, url]);
    await receiveMessage({ type: 'navigate', url: `${origin}/missing` });
    assert.deepEqual(history, [`${origin}/other`, `${origin}/redirect`, `${url}?toggle=1`, url]);
    for (let i = 0; i < 6; i++) await receiveMessage({ type: 'navigate', url: `${origin}/visit-${i}` });
    assert.deepEqual(history, [5, 4, 3, 2, 1].map((i) => `${origin}/visit-${i}`));
    const otherProjectKey = 'navigationHistory:/another-project';
    storedHistory.set(otherProjectKey, [url]);
    await receiveMessage({ type: 'clearNavigationHistory' });
    assert.deepEqual(history, []);
    assert.deepEqual(storedHistory.get(otherProjectKey), [url]);
    assert.equal(inspectedUrl, `${origin}/visit-5`);
  } finally {
    subscriptions.forEach((subscription) => subscription.dispose());
    await deactivate();
    closePanel?.();
  }
}

function findPlaywrightPackageRoot() {
  const candidates = [
    process.env.PLAYWRIGHT_PACKAGE_ROOT,
    extensionRoot,
    path.resolve(extensionRoot, '..'),
  ].filter(Boolean);

  for (const base of candidates) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      for (const pkg of ['@playwright/test', 'playwright', 'playwright-core']) {
        try {
          const resolved = req.resolve(pkg);
          return path.dirname(resolved);
        } catch {
          // try next
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

const pwPkgRoot = findPlaywrightPackageRoot();
const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-locator-inspector-verify-'));

const receivedHeadersMain = [];
const server = http.createServer((req, res) => {
  receivedHeadersMain.push({ ...req.headers });
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/other' }).end();
    return;
  }
  if (req.url === '/missing') {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>Missing</h1>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url === '/other') {
    res.end(`<!doctype html><html><body><main><h1>Other Page</h1></main></body></html>`);
    return;
  }
  if (req.url === '/nuxt-startup' || req.url === '/nuxt-startup?marker-only') {
    const mountId = req.url.endsWith('?marker-only') ? 'custom-nuxt-root' : '__nuxt';
    res.end(`<!doctype html><div id="${mountId}"><div style="height: 2400px"></div>
      <h2 data-testid="save-btn">Target below the fold</h2></div>
      <script type="application/json" data-nuxt-data>[]</script>
      <script>
        history.scrollRestoration = 'manual';
        const app = { isHydrating: true };
        const root = document.getElementById('__nuxt');
        if (root) root.__vue_app__ = { config: { globalProperties: { $nuxt: app } } };
        window.finishStartup = () => {
          window.scrollTo({ top: 0, behavior: 'instant' });
          app.isHydrating = false;
        };
      </script>`);
    return;
  }
  res.end(`<!doctype html><html><head><meta name="description" content="Demo Page"><style>@media (min-width: 600px) { #mobile-menu { display: none; } }</style></head><body>
    ${req.url?.includes('toggle=1') ? '<script>setTimeout(() => { const b = document.createElement("button"); b.id = "mobile-menu"; b.textContent = "Mobile menu"; document.body.append(b); setTimeout(() => b.remove(), 1150); }, 850);</script>' : '<button id="mobile-menu">Mobile menu</button>'}
    <a href="/other">Other page</a>
    <main data-testid="main-root">
      <h1>Demo Page</h1>
      <section data-qa="profile-card">
        <div class="field"><label>Name</label><input type="text" value="Alice" /></div>
        <div class="field"><label>Email</label><input type="email" value="alice@example.org" /></div>
        <button data-testid="save-btn">Save</button>
      </section>
      <section data-qa="switches">
        <div><span>Notifications</span><button role="switch" aria-checked="true">On</button></div>
        <div><span>Dark Mode</span><button role="switch" aria-checked="false">Off</button></div>
      </section>
    </main>
  </body></html>`);
});

const receivedHeadersThirdParty = [];
const thirdPartyServer = http.createServer((req, res) => {
  receivedHeadersThirdParty.push({ ...req.headers });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body><h1>Third Party Origin</h1></body></html>`);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => thirdPartyServer.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const { port: thirdPartyPort } = thirdPartyServer.address();
const baseUrl = `http://127.0.0.1:${port}`;
const thirdPartyUrl = `http://127.0.0.1:${thirdPartyPort}`;

try {
  // Build synthetic Playwright workspace
  fs.mkdirSync(path.join(tmpProject, '.auth'), { recursive: true });
  fs.mkdirSync(path.join(tmpProject, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmpProject, 'node_modules'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpProject, 'package.json'),
    JSON.stringify({ name: 'demo-pw-project', version: '1.0.0' }, null, 2)
  );
  if (pwPkgRoot) {
    const pkgName = pwPkgRoot.includes('@playwright') ? '@playwright' : 'playwright';
    if (pkgName === '@playwright') {
      fs.mkdirSync(path.join(tmpProject, 'node_modules', '@playwright'), { recursive: true });
      fs.symlinkSync(
        pwPkgRoot,
        path.join(tmpProject, 'node_modules', '@playwright', 'test'),
        'dir'
      );
    } else {
      fs.symlinkSync(pwPkgRoot, path.join(tmpProject, 'node_modules', 'playwright'), 'dir');
    }
  }

  fs.writeFileSync(
    path.join(tmpProject, '.env'),
    [
      `BASE_URL=${baseUrl}`,
      `API_TOKEN=super-secret-token-123`,
      `DB_PASSWORD=super-secret-password`,
      `CUSTOM_SAFE_TAG=public-tag`,
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(tmpProject, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: {
    baseURL: process.env.BASE_URL || '${baseUrl}',
    testIdAttribute: 'data-qa,data-testid',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US',
      'X-Inspector-Safe': 'ok',
      'Authorization': 'Bearer should-be-stripped',
      'X-API-Key': 'secret-key-should-be-stripped',
      'X-From-Env': process.env.CUSTOM_SAFE_TAG || 'fallback',
    },
  },
});`
  );

  const validStoragePath = path.join(tmpProject, '.auth', 'session.json');
  const invalidStoragePath = path.join(tmpProject, '.auth', 'user-meta.json');
  const secretJsonPath = path.join(tmpProject, 'credentials.json');
  fs.writeFileSync(
    validStoragePath,
    JSON.stringify({
      cookies: [{ name: 'sid', value: 'demo123', domain: '127.0.0.1', path: '/' }],
      origins: [],
    })
  );
  fs.writeFileSync(invalidStoragePath, JSON.stringify({ username: 'demo' }));
  fs.writeFileSync(
    secretJsonPath,
    JSON.stringify({
      cookies: [{ name: 'leaked', value: 'x', domain: '127.0.0.1', path: '/' }],
      origins: [],
    })
  );

  const demoPagePath = path.join(tmpProject, 'src', 'pages', 'DemoPage.ts');
  fs.writeFileSync(
    demoPagePath,
    `import { Page, Locator, expect } from '@playwright/test';

const LABELS = {
  name: 'Name',
  email: 'Email',
  switches: ['Notifications', 'Dark Mode'],
};

export class DemoPage {
  readonly page: Page;
  readonly mainRoot: Locator;
  readonly profileSection: {
    root: Locator;
    nameInput: Locator;
    emailInput: Locator;
    saveButton: Locator;
  };

  constructor(page: Page) {
    this.page = page;
    this.mainRoot = page.getByTestId('main-root');

    const profileRoot = this.mainRoot
      .locator('section')
      .filter({ has: page.getByTestId('save-btn') });

    const fieldInputByLabel = (labelText: string): Locator =>
      profileRoot
        .locator('div.field')
        .filter({ has: page.locator('label', { hasText: labelText }) })
        .locator('input');

    this.profileSection = {
      root: profileRoot,
      nameInput: fieldInputByLabel(LABELS.name),
      emailInput: fieldInputByLabel(LABELS.email),
      saveButton: page.getByTestId('save-btn'),
    };
  }

  getSwitch(label: string): Locator {
    return this.mainRoot
      .locator('div')
      .filter({ hasText: label })
      .getByRole('switch')
      .first();
  }

  async save(): Promise<void> {
    await expect(this.profileSection.saveButton).toBeVisible();
    await this.profileSection.saveButton.click();
  }
}
`
  );

  console.log('=== 1. Security, StorageState validation & AST resolver checks ===');
  assert.equal(isSensitiveEnvKey('API_TOKEN'), true);
  assert.equal(isSensitiveEnvKey('DB_PASSWORD'), true);
  assert.equal(isSensitiveEnvKey('BASE_URL'), false);
  assert.equal(isSensitiveHeaderName('Authorization'), true);
  assert.equal(isSensitiveHeaderName('X-API-Key'), true);
  assert.equal(isSensitiveHeaderName('Accept-Language'), false);
  assert.equal(sanitizeBaseUrl('https://user:pass@example.com'), undefined);
  assert.equal(sanitizeBaseUrl('javascript:alert(1)'), undefined);
  assert.equal(sanitizeBaseUrl('https://example.com'), 'https://example.com');

  // Verify .env is NOT read when readEnvFiles is false (default)
  const tmpEnvOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-env-check-'));
  try {
    fs.writeFileSync(
      path.join(tmpEnvOnlyDir, '.env'),
      'BASE_URL=https://from-env.example.com\nAPI_TOKEN=secret\n'
    );
    const cfgWithoutEnv = loadPlaywrightConfigSettings(tmpEnvOnlyDir);
    assert.equal(cfgWithoutEnv.baseURL, undefined);
    const cfgWithEnv = loadPlaywrightConfigSettings(tmpEnvOnlyDir, { readEnvFiles: true });
    assert.equal(cfgWithEnv.baseURL, 'https://from-env.example.com');
  } finally {
    fs.rmSync(tmpEnvOnlyDir, { recursive: true, force: true });
  }

  const parsedCfg = loadPlaywrightConfigSettings(tmpProject, { readEnvFiles: true });
  assert.equal(parsedCfg.extraHTTPHeaders?.['Accept-Language'], 'en-US');
  assert.equal(parsedCfg.extraHTTPHeaders?.['X-Inspector-Safe'], 'ok');
  assert.equal(parsedCfg.extraHTTPHeaders?.['Authorization'], undefined);
  assert.equal(parsedCfg.extraHTTPHeaders?.['X-API-Key'], undefined);
  // process.env lookup must not resolve inside extraHTTPHeaders (falls back to literal 'fallback' only)
  assert.equal(parsedCfg.extraHTTPHeaders?.['X-From-Env'], 'fallback');

  assert.equal(isValidPlaywrightStorageStateFile(validStoragePath).valid, true);
  assert.equal(isValidPlaywrightStorageStateFile(invalidStoragePath).valid, false);
  const discovered = discoverStorageStateFiles(tmpProject);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].label, path.join('.auth', 'session.json'));

  const resolvedSave = resolveLocatorAtPosition({
    filePath: demoPagePath,
    line: 51,
    column: 35,
  });
  assert.equal(resolvedSave.strippedActionMethod, 'click');
  assert.equal(resolvedSave.descriptor?.humanReadable, 'page.getByTestId("save-btn")');

  const resolvedHelper = resolveLocatorAtPosition({
    filePath: demoPagePath,
    line: 27,
    column: 12,
  });
  assert.equal(resolvedHelper.requiresParameterSelection, true);
  assert.equal(resolvedHelper.variants.length, 2);

  const collected = collectFileLocators({ filePath: demoPagePath });
  assert.ok(collected.length >= 6, `Expected >= 6 collected locators, got ${collected.length}`);
  console.log(`✓ AST & storageState checks passed (collected ${collected.length} locators)`);

  if (!pwPkgRoot) {
    console.log('⚠ Playwright package not found in local environment; skipping live browser checks.');
    process.exit(0);
  }

  await verifySelectionBadge(demoPagePath, `${baseUrl}/badge`);
  console.log('✓ После ручной навигации бейдж и инспектор показывают одно совпадение');

  console.log('=== 2. Live BrowserManager, CDP Screencast & Webview HTML checks ===');
  const runtime = resolveWorkspacePlaywright(demoPagePath, tmpProject);
  assert.equal(runtime.config.testIdAttribute, 'data-qa,data-testid');

  const bm = new BrowserManager();
  let frames = 0;
  bm.on('screencastFrame', () => {
    frames += 1;
  });

  try {
    await bm.ensureStarted({
      activeFilePath: demoPagePath,
      workspaceRoot: tmpProject,
      initialUrl: baseUrl,
      viewport: { width: 1280, height: 800 },
    });
    const page = bm.getPage();
    await page.getByTestId('save-btn').waitFor({ state: 'visible' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(frames > 0, 'Expected at least 1 CDP screencast frame');

    // Verify safe extraHTTPHeaders are sent ONLY to baseURL origin and sensitive headers are never sent
    assert.ok(receivedHeadersMain.length > 0, 'Expected at least 1 request to main server');
    assert.equal(receivedHeadersMain[0]['x-inspector-safe'], 'ok');
    assert.equal(receivedHeadersMain[0]['authorization'], undefined);
    assert.equal(receivedHeadersMain[0]['x-api-key'], undefined);

    await bm.navigate(thirdPartyUrl);
    assert.ok(
      receivedHeadersThirdParty.length > 0,
      'Expected at least 1 request to third-party origin'
    );
    assert.equal(receivedHeadersThirdParty[0]['x-inspector-safe'], undefined);
    assert.equal(receivedHeadersThirdParty[0]['authorization'], undefined);

    await bm.navigate(baseUrl);
    await page.getByTestId('save-btn').waitFor({ state: 'visible' });

    const hlSave = await bm.highlightLocator(resolvedSave.descriptor, {
      expressionText: resolvedSave.expressionText,
      strippedActionMethod: resolvedSave.strippedActionMethod,
    });
    assert.equal(hlSave.count, 1);
    assert.equal(hlSave.statusText, 'Found: 1 (visible: 1) [action .click() stripped]');
    assert.equal(await page.locator('x-pw-inspector-banner').count(), 0);
    assert.equal(await page.locator('x-pw-glass').count(), 0);
    assert.deepEqual(await page.locator('x-pw-inspector-badge').allTextContents(), ['1']);
    // Три итерации, затем одна картинка пропадает из DOM.
    await page.evaluate(() => {
      for (const title of ['Alpha', 'Beta', 'Gamma']) {
        const card = document.createElement('div');
        card.setAttribute('data-testid', 'card');
        const image = document.createElement('img');
        image.alt = title;
        image.width = image.height = 24;
        card.append(image);
        document.body.append(card);
      }
    });
    const allCards = await bm.highlightLocator(loopDescriptor);
    assert.equal(allCards.count, 3);
    assert.deepEqual(allCards.elements.map((el) => el.imageAlt), ['Alpha', 'Beta', 'Gamma']);
    assert.equal(await page.locator('x-pw-inspector-box').count(), 3);
    const focused = await bm.focusHighlightedElement(1);
    assert.match(focused.humanReadable, /\.nth\(1\)\.getByRole\("img", \{ name: "Beta" \}\)$/);
    assert.equal(await page.locator('x-pw-inspector-box').count(), 1);
    await page.getByRole('img', { name: 'Beta' }).evaluate((image) => image.remove());
    assert.equal((await bm.highlightLocator(loopDescriptor)).count, 2);
    assert.match((await bm.focusHighlightedElement(1)).humanReadable, /\.nth\(2\)/);
    const waitForScrollTarget = () => page.waitForFunction(() => {
      const { top, bottom } = document.querySelector('h2').getBoundingClientRect();
      return top >= 0 && bottom <= innerHeight;
    }, undefined, { timeout: 5000 });
    await bm.navigate(`${baseUrl}/nuxt-startup`);
    for (const reloading of [false, true]) {
      if (reloading) {
        const highlighted = once(bm, 'highlightChanged', { signal: AbortSignal.timeout(5000) });
        await bm.reload();
        const [result] = await highlighted;
        assert.equal(result.count, 1);
      } else {
        assert.equal((await bm.highlightLocator(resolvedSave.descriptor)).count, 1);
      }
      assert.ok(await page.getByRole('heading', { name: 'Target below the fold' }).evaluate(
        (el) => el.getBoundingClientRect().top > innerHeight
      ), 'Nuxt still owns the viewport while hydrating');
      await page.evaluate(() => window.finishStartup());
      await waitForScrollTarget();
    }
    await bm.navigate(`${baseUrl}/nuxt-startup?marker-only`);
    assert.equal((await bm.highlightLocator(resolvedSave.descriptor)).count, 1);
    await waitForScrollTarget();
    console.log('✓ Locator scroll follows Nuxt startup and reload');

    await bm.clearHighlight(true);
    await bm.reload();
    assert.equal(bm.getStateSnapshot().lastHighlight, undefined);
    assert.equal(await page.locator('x-pw-inspector-overlay').count(), 0);
    await bm.navigate(baseUrl);

    // Задерживаем поиск после его запуска, чтобы Clear отработал первым.
    const originalClear = bm.clearHighlight.bind(bm);
    let releaseSearch;
    const deferredSearch = new Promise((resolve) => { releaseSearch = resolve; });
    bm.clearHighlight = (reset) => reset ? originalClear(true) : deferredSearch;
    try {
      const pendingHighlight = bm.highlightLocator(resolvedSave.descriptor);
      await bm.clearHighlight(true);
      releaseSearch();
      await pendingHighlight;
      assert.equal(bm.getStateSnapshot().lastHighlight, undefined);
      assert.equal(await page.locator('x-pw-inspector-overlay').count(), 0);
    } finally {
      releaseSearch();
      bm.clearHighlight = originalClear;
    }

    const probeMissing = await bm.probeLocatorCount(
      resolveLocatorFromSnippet({ snippet: 'page.getByTestId("missing")', contextFilePath: demoPagePath })
        .descriptor
    );
    assert.equal(probeMissing.count, 0);

    const webviewPage = await page.context().newPage();
    const errors = [];
    webviewPage.on('pageerror', (e) => errors.push(String(e)));
    await webviewPage.evaluate(() => {
      window.__msgs = [];
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__msgs.push(m) });
    });
    await webviewPage.setContent(BrowserWebviewPanel.buildWebviewHtml(), { waitUntil: 'domcontentloaded' });
    assert.deepEqual(errors, []);
    assert.equal(await webviewPage.locator('#locator-status').textContent(), 'Waiting for page');
    assert.equal(await webviewPage.locator('#placeholder').textContent(), 'Waiting for navigation');
    assert.equal(await webviewPage.locator('#url-input').inputValue(), '');
    assert.equal(await webviewPage.locator('#url-input').getAttribute('placeholder'), 'Enter a URL to check the locator');
    await webviewPage.setViewportSize({ width: 360, height: 740 });
    const auth = await webviewPage.locator('.auth-group').boundingBox();
    const viewport = await webviewPage.locator('.viewport-group').boundingBox();
    assert.equal(auth.y, viewport.y);
    assert.equal(auth.width, viewport.width);
    assert.ok(viewport.x < auth.x, 'Viewport должен быть слева от Auth session');
    const viewportButton = webviewPage.getByRole('button', { name: 'Viewport' });
    assert.equal((await viewportButton.boundingBox()).height, 28);
    const fileButton = webviewPage.getByRole('button', { name: 'File', exact: true });
    const fileBox = await fileButton.boundingBox();
    for (const name of ['Go', 'History', 'Find']) {
      const box = await webviewPage.getByRole('button', { name, exact: true }).boundingBox();
      assert.equal(box.width, fileBox.width);
      assert.equal(box.height, fileBox.height);
    }
    assert.ok(await fileButton.evaluate((button) => button.scrollWidth <= button.clientWidth));
    assert.ok(await webviewPage.locator('#param-row').isVisible());
    assert.ok(await webviewPage.locator('#param-select').isDisabled());
    assert.equal(await webviewPage.locator('#param-custom-input').count(), 0);
    assert.equal(await webviewPage.locator('#btn-param-apply').count(), 0);
    assert.ok(await webviewPage.locator('#locator-chain').isVisible());
    assert.ok(await webviewPage.locator('#elements-row').isVisible());
    assert.ok(await webviewPage.locator('#elements-select').isDisabled());
    const chainEmptyHeight = (await webviewPage.locator('#locator-chain').boundingBox()).height;
    const loading = webviewPage.getByRole('progressbar', { name: 'Loading page' });
    assert.equal(await loading.isVisible(), false);
    const loadingUrl = `${baseUrl}/loading`;
    await webviewPage.evaluate((url) => window.postMessage({ type: 'state', payload: { currentUrl: url, pageReady: false, navigationLoading: true } }, '*'), loadingUrl);
    await loading.waitFor({ state: 'visible' });
    assert.notEqual(await loading.evaluate((el) => getComputedStyle(el).animationName), 'none');
    assert.equal(await webviewPage.locator('#navigation [role="progressbar"]').count(), 0);
    assert.ok(await webviewPage.locator('#viewport-host [role="progressbar"]').isVisible());
    assert.equal(await webviewPage.locator('#placeholder').isVisible(), false);
    await webviewPage.evaluate((url) => window.postMessage({ type: 'state', payload: { currentUrl: url, pageReady: false, navigationLoading: false, navigationError: 'Could not open the page.' } }, '*'), loadingUrl);
    await loading.waitFor({ state: 'hidden' });
    assert.ok(await webviewPage.getByRole('alert').isVisible());
    await webviewPage.getByRole('button', { name: 'History' }).click();
    await webviewPage.getByText('No navigation history').waitFor({ state: 'visible' });
    await webviewPage.keyboard.press('Escape');
    await webviewPage.getByRole('button', { name: 'Auth session' }).click();
    await webviewPage.getByRole('listbox', { name: 'Auth session' }).getByRole('option').first().waitFor();
    await webviewPage.keyboard.press('Escape');
    await webviewPage.getByRole('listbox', { name: 'Auth session' }).waitFor({ state: 'hidden' });
    await webviewPage.getByRole('button', { name: 'Viewport' }).press('ArrowDown');
    await webviewPage.getByRole('listbox', { name: 'Viewport' }).getByRole('option', { name: /Mobile/ }).click();
    assert.ok(await webviewPage.evaluate(() => window.__msgs.some((m) => m.type === 'setViewport' && m.width === 393)));
    const longChain = 'page.getByTestId("main-root").getByTestId("profile-card").getByRole("button", { name: "Save" })';
    await webviewPage.evaluate(({ highlight, url }) => {
      window.postMessage({ type: 'state', payload: { pageReady: true, currentUrl: url, lastHighlight: highlight } }, '*');
    }, { highlight: { ...hlSave, humanReadable: longChain, count: 2, visibleCount: 2, elements: [hlSave.elements[0], { ...hlSave.elements[0], index: 1 }] }, url: baseUrl });
    const elementsButton = webviewPage.getByRole('button', { name: 'Elements' });
    await webviewPage.locator('#elements-select:enabled').waitFor();
    const browserPreview = webviewPage.locator('#viewport-host');
    const previewBefore = await browserPreview.boundingBox();
    await elementsButton.click();
    const elementsMenu = webviewPage.getByRole('listbox', { name: 'Elements' });
    const options = elementsMenu.getByRole('option');
    assert.equal(await options.count(), 3);
    assert.deepEqual(await browserPreview.boundingBox(), previewBefore);
    const menuBox = await elementsMenu.boundingBox();
    const triggerBox = await elementsButton.boundingBox();
    assert.ok(menuBox.y >= triggerBox.y + triggerBox.height);
    assert.ok(menuBox.y + menuBox.height > previewBefore.y);
    for (const option of await options.all()) {
      assert.ok(await option.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      }), 'Пункт меню должен быть доступен поверх предпросмотра');
    }
    const arrowSizes = await webviewPage.locator('.select-arrow').evaluateAll((arrows) =>
      arrows.map((arrow) => getComputedStyle(arrow).fontSize));
    assert.equal(new Set(arrowSizes).size, 1);
    assert.doesNotMatch(await options.last().textContent(), /•| \/ |\.nth\(|\.last\(/);
    assert.equal(await options.last().getAttribute('title'), `${longChain}.nth(1)`);
    const goBorder = await webviewPage.locator('#btn-go').evaluate((el) => getComputedStyle(el).borderTopColor);
    await options.nth(1).hover();
    await webviewPage.waitForFunction((color) => {
      const hovered = document.querySelector('#elements-options [role="option"]:hover');
      return hovered && getComputedStyle(hovered).borderTopColor === color;
    }, goBorder, { timeout: 2000 });
    await options.last().hover();
    await webviewPage.waitForFunction((color) => {
      const rows = document.querySelectorAll('#elements-options [role="option"]');
      return getComputedStyle(rows[2]).borderTopColor === color && getComputedStyle(rows[1]).borderTopColor !== color;
    }, goBorder, { timeout: 2000 });
    await options.last().click();
    assert.ok(await webviewPage.evaluate(() => window.__msgs.some((m) => m.type === 'focusElement' && m.index === 1)));
    const chainLongBox = await webviewPage.locator('#locator-chain').boundingBox();
    assert.ok(
      await webviewPage.locator('#locator-chain').evaluate((el) => el.scrollWidth > el.clientWidth && el.classList.contains('has-horizontal-scroll')),
      'Длинная цепочка Playwright должна включать расширенный режим при горизонтальном скролле'
    );
    assert.ok(chainLongBox.height > chainEmptyHeight, 'Поле Playwright должно увеличиваться по высоте при горизонтальном скролле');
    const paramHighlight = {
      ...hlSave,
      humanReadable: 'page.getByText("0-4")',
      parameterInfo: {
        baseExpressionText: 'this.form.root.getByText(expectedMessage, { exact: true })',
        parameterNames: ['expectedMessage'],
        activeVariantId: 'v1',
        variants: [
          { id: 'v1', label: '0-4', parameters: { expectedMessage: '0-4' } },
          { id: 'v2', label: '5-9', parameters: { expectedMessage: '5-9' } },
          { id: 'v3', label: '10-14', parameters: { expectedMessage: '10-14' } },
          { id: 'v4', label: '15-29', parameters: { expectedMessage: '15-29' } },
          { id: 'v5', label: '30-39', parameters: { expectedMessage: '30-39' } },
          { id: 'v6', label: '40-49', parameters: { expectedMessage: '40-49' } },
        ],
      },
    };
    await webviewPage.evaluate(({ highlight, url }) => {
      window.postMessage({ type: 'state', payload: { pageReady: true, currentUrl: url, lastHighlight: highlight } }, '*');
    }, { highlight: paramHighlight, url: baseUrl });
    const paramButton = webviewPage.getByRole('button', { name: 'Parameter' });
    await webviewPage.locator('#param-select:enabled').waitFor();
    assert.equal(await webviewPage.locator('#param-value').textContent(), '"0-4"');
    const paramRowBox = await webviewPage.locator('#param-row').boundingBox();
    const paramButtonBox = await paramButton.boundingBox();
    assert.ok(
      paramButtonBox.x + paramButtonBox.width <= paramRowBox.x + paramRowBox.width + 1 && paramButtonBox.x + paramButtonBox.width <= 360,
      'Dropdown параметров не должен выходить за пределы строки и экрана'
    );
    await paramButton.click();
    const paramMenu = webviewPage.getByRole('listbox', { name: 'Parameter' });
    assert.equal(await paramMenu.getByRole('option').count(), 6);
    await paramMenu.getByRole('option', { name: '"5-9"' }).click();
    assert.ok(await webviewPage.evaluate(() => window.__msgs.some((m) => m.type === 'selectParameterVariant' && m.variantId === 'v2')));
    assert.equal(
      await webviewPage.locator('#locator-chain').evaluate((el) => el.classList.contains('has-horizontal-scroll')),
      false
    );
    const details = webviewPage.locator('#inspector-details');
    const detailsBefore = await details.boundingBox();
    await webviewPage.locator('#locator-search-input').fill('invalid locator');
    await webviewPage.evaluate(() => {
      window.postMessage({ type: 'searchError', payload: { message: 'Failed to parse locator' } }, '*');
    });
    assert.equal(await webviewPage.locator('#locator-status').textContent(), 'Failed to parse locator');
    assert.equal(await webviewPage.locator('#locator-chain').textContent(), '');
    assert.equal(await webviewPage.locator('#elements-value').textContent(), '');
    assert.equal(await webviewPage.locator('#param-value').textContent(), '');
    assert.ok(await paramButton.isDisabled());
    assert.ok(await elementsButton.isDisabled());
    assert.equal(await webviewPage.locator('#locator-search-input').inputValue(), 'invalid locator');
    await webviewPage.locator('#btn-clear-highlight').click();
    assert.equal(await webviewPage.locator('#locator-chain').textContent(), '');
    assert.equal(await webviewPage.locator('#elements-value').textContent(), '');
    assert.equal(await webviewPage.locator('#param-value').textContent(), '');
    assert.ok(await webviewPage.locator('#param-row').isVisible());
    assert.ok(await paramButton.isDisabled());
    assert.ok(await elementsButton.isDisabled());
    assert.deepEqual(await details.boundingBox(), detailsBefore);
    assert.equal(await webviewPage.locator('select').count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(await webviewPage.locator('#btn-fit-mode').count(), 0);
    assert.equal(await webviewPage.locator('#test-id-info').count(), 0);
    const previewFrame = webviewPage.locator('#screen-img');
    await webviewPage.evaluate((pageUrl) => window.postMessage({ type: 'screencastFrame', payload: { pageUrl, data: 'AA==' } }, '*'), baseUrl);
    await previewFrame.waitFor({ state: 'visible' });
    await webviewPage.getByRole('textbox', { name: 'URL', exact: true }).fill('');
    await previewFrame.waitFor({ state: 'hidden' });
    assert.equal(await previewFrame.getAttribute('src'), null);
    assert.equal(await webviewPage.locator('#placeholder').textContent(), 'Waiting for navigation');
    assert.ok(await webviewPage.evaluate(() => window.__msgs.some((m) => m.type === 'navigate' && m.url === 'about:blank')));
    await webviewPage.close();

    const [[, visitedUrls]] = await Promise.all([
      once(bm, 'navigationVisited', { signal: AbortSignal.timeout(5000) }),
      page.getByRole('link', { name: 'Other page' }).click(),
    ]);
    assert.deepEqual(visitedUrls, [`${baseUrl}/other`]);

    console.log('✓ Live browser & Webview UI checks passed!');
  } finally {
    await bm.dispose();
  }
} finally {
  server.close();
  thirdPartyServer.close();
  fs.rmSync(tmpProject, { recursive: true, force: true });
  if (fs.existsSync(coreBundleOut)) {
    fs.unlinkSync(coreBundleOut);
  }
}
