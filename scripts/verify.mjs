import assert from 'node:assert/strict';
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
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const {
  resolveWorkspacePlaywright,
  discoverStorageStateFiles,
  isValidPlaywrightStorageStateFile,
  resolveLocatorAtPosition,
  resolveLocatorFromSnippet,
  collectFileLocators,
  materializeLocator,
  BrowserManager,
  BrowserWebviewPanel,
} = require(coreBundleOut);

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

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url === '/other') {
    res.end(`<!doctype html><html><body><main><h1>Other Page</h1></main></body></html>`);
    return;
  }
  res.end(`<!doctype html><html><body>
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

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

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
    path.join(tmpProject, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: {
    baseURL: '${baseUrl}',
    testIdAttribute: 'data-qa,data-testid',
  },
});`
  );

  const validStoragePath = path.join(tmpProject, '.auth', 'session.json');
  const invalidStoragePath = path.join(tmpProject, '.auth', 'user-meta.json');
  fs.writeFileSync(
    validStoragePath,
    JSON.stringify({
      cookies: [{ name: 'sid', value: 'demo123', domain: '127.0.0.1', path: '/' }],
      origins: [],
    })
  );
  fs.writeFileSync(invalidStoragePath, JSON.stringify({ username: 'demo' }));

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

  console.log('=== 1. StorageState validation & AST resolver checks ===');
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

    const hlSave = await bm.highlightLocator(resolvedSave.descriptor, {
      expressionText: resolvedSave.expressionText,
      strippedActionMethod: resolvedSave.strippedActionMethod,
    });
    assert.equal(hlSave.count, 1);
    assert.equal(hlSave.statusText, 'Found: 1 (visible: 1) [action .click() stripped]');

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
    assert.equal(await webviewPage.locator('#locator-status').textContent(), 'Waiting for locator');
    assert.equal(await webviewPage.locator('#btn-fit-mode').count(), 0);
    assert.equal(await webviewPage.locator('#test-id-info').count(), 0);
    await webviewPage.close();

    console.log('✓ Live browser & Webview UI checks passed!');
  } finally {
    await bm.dispose();
  }
} finally {
  server.close();
  fs.rmSync(tmpProject, { recursive: true, force: true });
  if (fs.existsSync(coreBundleOut)) {
    fs.unlinkSync(coreBundleOut);
  }
}
