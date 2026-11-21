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
  resolveLocatorFromSnippet,
  collectFileLocators,
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
    await bm.clearHighlight(true);
    await bm.reload();
    assert.equal(bm.getStateSnapshot().lastHighlight, undefined);
    assert.equal(await page.locator('x-pw-inspector-overlay').count(), 0);

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
    assert.ok(await webviewPage.locator('#locator-chain').isVisible());
    assert.ok(await webviewPage.locator('#elements-row').isVisible());
    assert.ok(await webviewPage.locator('#elements-select').isDisabled());
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
    await webviewPage.evaluate(({ highlight, url }) => {
      window.postMessage({ type: 'state', payload: { pageReady: true, currentUrl: url, lastHighlight: highlight } }, '*');
    }, { highlight: { ...hlSave, count: 2, visibleCount: 2, elements: [hlSave.elements[0], { ...hlSave.elements[0], index: 1 }] }, url: baseUrl });
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
    assert.equal(await options.last().getAttribute('title'), `${hlSave.humanReadable}.nth(1)`);
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
    const details = webviewPage.locator('#inspector-details');
    const detailsBefore = await details.boundingBox();
    await webviewPage.locator('#btn-clear-highlight').click();
    assert.equal(await webviewPage.locator('#locator-chain').textContent(), '');
    assert.equal(await webviewPage.locator('#elements-value').textContent(), '');
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
