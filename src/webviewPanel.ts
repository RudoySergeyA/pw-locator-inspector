import * as vscode from 'vscode';
import {
  BrowserManager,
  BrowserStateSnapshot,
  HighlightLocatorResult,
  ScreencastFramePayload,
} from './browserManager';

export type SearchLocatorSnippetHandler = (snippet: string) => Promise<void>;
export type SelectParameterVariantHandler = (variantId: string) => Promise<void>;
export type ApplyCustomParameterHandler = (
  overrides: Record<string, string | number | boolean>
) => Promise<void>;

export class BrowserWebviewPanel {
  public static readonly viewType = 'pwLocatorInspector.browserView';
  private static currentInstance?: BrowserWebviewPanel;
  private static readonly onDidCloseEmitter = new vscode.EventEmitter<void>();
  public static readonly onDidClose = BrowserWebviewPanel.onDidCloseEmitter.event;

  public static isOpen(): boolean {
    return Boolean(BrowserWebviewPanel.currentInstance);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly browserManager: BrowserManager;
  private readonly disposables: vscode.Disposable[] = [];
  private onSearchLocatorSnippet?: SearchLocatorSnippetHandler;
  private onSelectParameterVariant?: SelectParameterVariantHandler;
  private onApplyCustomParameter?: ApplyCustomParameterHandler;

  public static async createOrShow(
    context: vscode.ExtensionContext,
    browserManager: BrowserManager,
    options?: {
      activeFilePath?: string;
      workspaceRoot?: string;
      initialUrl?: string;
      storageStatePath?: string;
      viewport?: { width: number; height: number };
      onSearchLocatorSnippet?: SearchLocatorSnippetHandler;
      onSelectParameterVariant?: SelectParameterVariantHandler;
      onApplyCustomParameter?: ApplyCustomParameterHandler;
    }
  ): Promise<BrowserWebviewPanel> {
    if (BrowserWebviewPanel.currentInstance) {
      if (options?.onSearchLocatorSnippet) {
        BrowserWebviewPanel.currentInstance.onSearchLocatorSnippet =
          options.onSearchLocatorSnippet;
      }
      if (options?.onSelectParameterVariant) {
        BrowserWebviewPanel.currentInstance.onSelectParameterVariant =
          options.onSelectParameterVariant;
      }
      if (options?.onApplyCustomParameter) {
        BrowserWebviewPanel.currentInstance.onApplyCustomParameter =
          options.onApplyCustomParameter;
      }
      if (!BrowserWebviewPanel.currentInstance.panel.visible) {
        BrowserWebviewPanel.currentInstance.panel.reveal(
          BrowserWebviewPanel.currentInstance.panel.viewColumn,
          true
        );
      }
      await browserManager.ensureStarted(options);
      BrowserWebviewPanel.currentInstance.postState(
        browserManager.getStateSnapshot()
      );
      return BrowserWebviewPanel.currentInstance;
    }

    const panel = vscode.window.createWebviewPanel(
      BrowserWebviewPanel.viewType,
      'Playwright Browser Inspector',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    BrowserWebviewPanel.currentInstance = new BrowserWebviewPanel(
      panel,
      browserManager,
      options?.onSearchLocatorSnippet,
      options?.onSelectParameterVariant,
      options?.onApplyCustomParameter
    );

    await browserManager.ensureStarted(options);
    BrowserWebviewPanel.currentInstance.postState(
      browserManager.getStateSnapshot()
    );

    return BrowserWebviewPanel.currentInstance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    browserManager: BrowserManager,
    onSearchLocatorSnippet?: SearchLocatorSnippetHandler,
    onSelectParameterVariant?: SelectParameterVariantHandler,
    onApplyCustomParameter?: ApplyCustomParameterHandler
  ) {
    this.panel = panel;
    this.browserManager = browserManager;
    this.onSearchLocatorSnippet = onSearchLocatorSnippet;
    this.onSelectParameterVariant = onSelectParameterVariant;
    this.onApplyCustomParameter = onApplyCustomParameter;

    this.panel.webview.html = this.getHtmlForWebview();

    const onFrame = (frame: ScreencastFramePayload) => {
      this.panel.webview.postMessage({
        type: 'screencastFrame',
        payload: frame,
      });
    };

    const onState = (state: BrowserStateSnapshot) => {
      this.postState(state);
    };

    const onHighlight = (highlight: HighlightLocatorResult) => {
      this.panel.webview.postMessage({
        type: 'highlightResult',
        payload: highlight,
      });
    };

    this.browserManager.on('screencastFrame', onFrame);
    this.browserManager.on('stateChanged', onState);
    this.browserManager.on('highlightChanged', onHighlight);

    this.disposables.push(
      new vscode.Disposable(() => {
        this.browserManager.off('screencastFrame', onFrame);
        this.browserManager.off('stateChanged', onState);
        this.browserManager.off('highlightChanged', onHighlight);
      })
    );

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        await this.handleWebviewMessage(msg);
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.dispose();
      },
      null,
      this.disposables
    );
  }

  public postState(state: BrowserStateSnapshot): void {
    this.panel.webview.postMessage({
      type: 'state',
      payload: state,
    });
  }

  public setSearchInputValue(expressionText: string): void {
    this.panel.webview.postMessage({
      type: 'setSearchInput',
      payload: { expressionText },
    });
  }

  public postSearchError(message: string): void {
    this.panel.webview.postMessage({
      type: 'searchError',
      payload: { message },
    });
  }

  public refreshHtml(): void {
    this.panel.webview.html = this.getHtmlForWebview();
  }

  public static buildWebviewHtml(): string {
    return BrowserWebviewPanel.prototype.getHtmlForWebview();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleWebviewMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    try {
      switch (msg.type) {
        case 'ready':
          this.postState(this.browserManager.getStateSnapshot());
          break;
        case 'navigate':
          if (typeof msg.url === 'string') {
            await this.browserManager.navigate(msg.url);
          }
          break;
        case 'goBack':
          await this.browserManager.goBack();
          break;
        case 'goForward':
          await this.browserManager.goForward();
          break;
        case 'reload':
          await this.browserManager.reload();
          break;
        case 'setStorageState':
          if (typeof msg.storageStatePath === 'string') {
            await this.browserManager.setStorageState(msg.storageStatePath);
          }
          break;
        case 'chooseStorageStateFile': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Playwright Storage State JSON': ['json'] },
            openLabel: 'Apply storageState',
          });
          if (picked && picked[0]) {
            await this.browserManager.setStorageState(picked[0].fsPath);
          }
          break;
        }
        case 'setViewport':
          if (typeof msg.width === 'number' && typeof msg.height === 'number') {
            await this.browserManager.setViewportSize(msg.width, msg.height);
          }
          break;
        case 'searchLocatorSnippet':
          if (typeof msg.snippet === 'string' && this.onSearchLocatorSnippet) {
            await this.onSearchLocatorSnippet(msg.snippet);
          }
          break;
        case 'focusElement':
          await this.browserManager.focusHighlightedElement(
            typeof msg.index === 'number' ? msg.index : null
          );
          break;
        case 'selectParameterVariant':
          if (
            typeof msg.variantId === 'string' &&
            this.onSelectParameterVariant
          ) {
            await this.onSelectParameterVariant(msg.variantId);
          }
          break;
        case 'applyCustomParameter':
          if (
            msg.overrides &&
            typeof msg.overrides === 'object' &&
            this.onApplyCustomParameter
          ) {
            await this.onApplyCustomParameter(msg.overrides);
          }
          break;
        case 'clearHighlight':
          await this.browserManager.clearHighlight(true);
          break;
        case 'mouseEvent':
          await this.browserManager.handleMouseEvent(msg.event);
          break;
        case 'keyEvent':
          await this.browserManager.handleKeyEvent(msg.event);
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Playwright Browser Inspector: ${message}`);
    }
  }

  public dispose(): void {
    BrowserWebviewPanel.currentInstance = undefined;
    BrowserWebviewPanel.onDidCloseEmitter.fire();
    while (this.disposables.length > 0) {
      const d = this.disposables.pop();
      d?.dispose();
    }
    void this.browserManager.dispose();
  }

  private getHtmlForWebview(): string {
    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Playwright Browser Inspector</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #0b1120);
      --panel-bg: var(--vscode-sideBar-background, var(--vscode-editorGroupHeader-tabsBackground, #161f33));
      --card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBarSectionHeader-background, #0f172a));
      --input-bg: var(--vscode-input-background, #0b1120);
      --input-fg: var(--vscode-input-foreground, var(--vscode-editor-foreground, #f8fafc));
      --input-placeholder: var(--vscode-input-placeholderForeground, #94a3b8);
      --btn-bg: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background, #1e293b));
      --btn-hover-bg: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground, #263449));
      --btn-fg: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground, #f8fafc));
      --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.28)));
      --border-light: var(--vscode-input-border, var(--vscode-contrastBorder, rgba(128, 128, 128, 0.36)));
      --text: var(--vscode-editor-foreground, #f8fafc);
      --muted: var(--vscode-descriptionForeground, #94a3b8);
      --accent: var(--vscode-focusBorder, #38bdf8);
      --accent-link: var(--vscode-textLink-foreground, #7dd3fc);
      --code-pw: var(--vscode-textLink-foreground, #93c5fd);
      --viewport-bg: var(--vscode-editor-background, #0b1120);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: none;
    }

    /* Top control bar */
    .top-controls {
      display: flex;
      align-items: stretch;
      gap: 8px;
      padding: 8px 10px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .control-group {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 4px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 8px;
    }
    .control-group.nav-group {
      flex: 1 1 360px;
      min-width: 280px;
    }
    .control-group.auth-group {
      flex: 0 1 auto;
    }
    .control-group.viewport-group {
      flex: 0 0 auto;
    }
    .group-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .group-row {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: 1px solid var(--border-light);
      border-radius: 6px;
      height: 28px;
      padding: 0 9px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      white-space: nowrap;
      transition: border-color 0.15s, background 0.15s;
    }
    .btn:hover {
      border-color: var(--accent);
      background: var(--btn-hover-bg);
    }
    .btn-primary {
      background: rgba(56, 189, 248, 0.14);
      border-color: rgba(56, 189, 248, 0.45);
      color: var(--accent-link);
    }
    .btn-primary:hover {
      background: rgba(56, 189, 248, 0.24);
      border-color: var(--accent);
    }
    .btn-clear {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .btn-clear:hover {
      background: rgba(239, 68, 68, 0.22);
      border-color: #f87171;
    }
    body.vscode-light .btn-primary,
    body.vscode-high-contrast-light .btn-primary {
      background: rgba(2, 132, 199, 0.12);
      border-color: rgba(2, 132, 199, 0.45);
      color: #0369a1;
    }
    body.vscode-light .btn-clear,
    body.vscode-high-contrast-light .btn-clear {
      background: rgba(220, 38, 38, 0.1);
      border-color: rgba(220, 38, 38, 0.35);
      color: #b91c1c;
    }
    .btn-action {
      height: 26px;
      padding: 0 10px;
      font-size: 11.5px;
    }

    .url-input {
      flex: 1;
      min-width: 160px;
      height: 28px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border-light);
      border-radius: 6px;
      padding: 0 10px;
      font-size: 12px;
      outline: none;
    }
    .url-input::placeholder,
    .locator-search-input::placeholder,
    .param-custom-input::placeholder {
      color: var(--input-placeholder);
    }
    .url-input:focus {
      border-color: var(--accent);
    }

    .select-wrapper {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .select-box {
      -webkit-appearance: none;
      appearance: none;
      height: 28px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border-light);
      border-radius: 6px;
      padding: 0 28px 0 9px;
      font-size: 12px;
      line-height: 26px;
      outline: none;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .select-box.auth-select {
      width: 240px;
    }
    .select-box.vp-select {
      width: 155px;
    }
    .select-box:hover,
    .select-box:focus {
      border-color: var(--accent);
    }
    .select-arrow {
      position: absolute;
      right: 9px;
      pointer-events: none;
      color: var(--muted);
      font-size: 10px;
    }

    /* Locator inspector card */
    .inspector-card {
      margin: 6px 10px 0 10px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      max-width: calc(100% - 20px);
      overflow: hidden;
      flex-shrink: 0;
    }
    .inspector-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: nowrap;
    }
    .inspector-title-area {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
      flex-wrap: nowrap;
      overflow: hidden;
    }
    .inspector-actions-area {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .inspector-search-row {
      display: flex;
      width: 100%;
    }
    .locator-search-input {
      width: 100%;
      min-height: 28px;
      max-height: 110px;
      height: 28px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border-light);
      border-radius: 6px;
      padding: 5px 10px;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      font-size: 12px;
      line-height: 1.35;
      outline: none;
      resize: none;
      overflow-y: hidden;
    }
    .locator-search-input:focus {
      border-color: var(--accent);
    }
    .badge {
      padding: 2px 9px;
      border-radius: 999px;
      font-weight: 600;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .badge-idle {
      background: rgba(148, 163, 184, 0.14);
      color: var(--muted);
      border: 1px solid rgba(148, 163, 184, 0.3);
    }
    .badge-ok {
      background: rgba(34, 197, 94, 0.16);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.38);
    }
    .badge-zero {
      background: rgba(239, 68, 68, 0.16);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.38);
    }
    body.vscode-light .badge-ok,
    body.vscode-high-contrast-light .badge-ok {
      background: rgba(22, 163, 74, 0.12);
      color: #15803d;
      border-color: rgba(22, 163, 74, 0.35);
    }
    body.vscode-light .badge-zero,
    body.vscode-high-contrast-light .badge-zero {
      background: rgba(220, 38, 38, 0.1);
      color: #b91c1c;
      border-color: rgba(220, 38, 38, 0.35);
    }

    .inspector-details {
      display: none;
      flex-direction: column;
      gap: 5px;
      margin-top: 2px;
      min-width: 0;
      max-width: 100%;
    }
    .inspector-block {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 9px;
      min-height: 30px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }
    .block-badge {
      flex: 0 0 88px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 20px;
      padding: 0 6px;
      border-radius: 4px;
      background: var(--panel-bg);
      border: 1px solid var(--border-light);
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
      user-select: none;
    }
    .code-line {
      flex: 1;
      min-width: 0;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      color: var(--text);
      font-size: 11.5px;
      line-height: 1.4;
      white-space: nowrap;
      overflow-x: auto;
      user-select: text;
      scrollbar-width: thin;
    }
    .code-line.pw-chain {
      color: var(--code-pw);
    }

    .param-toolbar,
    .elements-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .chips-scroll-track {
      display: flex;
      align-items: center;
      gap: 4px;
      overflow-x: auto;
      scrollbar-width: none;
      max-width: 55%;
      flex-shrink: 0;
    }
    .chips-scroll-track::-webkit-scrollbar {
      display: none;
    }
    .nav-chip {
      height: 22px;
      padding: 0 8px;
      border-radius: 4px;
      background: var(--btn-bg);
      border: 1px solid var(--border-light);
      color: var(--btn-fg);
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .nav-chip:hover {
      border-color: var(--accent);
      background: var(--btn-hover-bg);
    }
    .nav-chip.active {
      background: rgba(249, 115, 22, 0.22);
      border-color: #f97316;
      color: #fdba74;
    }
    .nav-chip.param-chip.active {
      background: rgba(56, 189, 248, 0.2);
      border-color: var(--accent);
      color: var(--accent-link);
    }
    body.vscode-light .nav-chip.active,
    body.vscode-high-contrast-light .nav-chip.active {
      color: #c2410c;
    }
    .select-wrapper.elements-select-wrapper {
      flex: 1 1 0%;
      width: 0;
      min-width: 0;
      max-width: 100%;
      display: flex;
    }
    .select-box.elements-select {
      width: 0;
      flex: 1 1 0%;
      min-width: 0;
      max-width: 100%;
      height: 24px;
      line-height: 22px;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      font-size: 11.5px;
      background: var(--card-bg);
    }
    .param-custom-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .param-custom-input {
      height: 22px;
      width: 150px;
      background: var(--card-bg);
      color: var(--input-fg);
      border: 1px solid var(--border-light);
      border-radius: 4px;
      padding: 0 7px;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 11px;
      outline: none;
    }
    .param-custom-input:focus {
      border-color: var(--accent);
    }

    .viewport-host {
      flex: 1;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      overflow: auto;
      background: var(--viewport-bg);
      position: relative;
      margin: 6px 10px 10px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px;
      min-height: 0;
    }
    #screen-img {
      display: block;
      width: auto;
      height: auto;
      max-width: 100%;
      max-height: 100%;
      border-radius: 4px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      cursor: default;
      outline: none;
    }
    body.vscode-light #screen-img,
    body.vscode-high-contrast-light #screen-img {
      box-shadow: 0 4px 16px rgba(15, 23, 42, 0.14);
      border: 1px solid var(--border);
    }
    .empty-placeholder {
      color: var(--muted);
      font-size: 13px;
      text-align: center;
      padding: 24px;
      margin: auto;
    }
  </style>
</head>
<body>
  <div class="top-controls">
    <!-- 1. Navigation -->
    <div class="control-group nav-group">
      <div class="group-label">Navigation</div>
      <div class="group-row">
        <button class="btn" id="btn-back" title="Back">←</button>
        <button class="btn" id="btn-forward" title="Forward">→</button>
        <button class="btn" id="btn-reload" title="Reload page">↻</button>
        <input class="url-input" id="url-input" type="text" placeholder="Enter URL (e.g. https://playwright.dev)" />
        <button class="btn btn-primary" id="btn-go" title="Navigate to URL">Go</button>
      </div>
    </div>

    <!-- 2. Auth session (storageState) -->
    <div class="control-group auth-group">
      <div class="group-label">Auth session</div>
      <div class="group-row">
        <div class="select-wrapper">
          <select class="select-box auth-select" id="storage-select" title="Select a Playwright storageState JSON file (cookies / localStorage)">
            <option value="">No auth (clean session)</option>
          </select>
          <span class="select-arrow">▾</span>
        </div>
        <button class="btn" id="btn-browse-storage" title="Load another storageState JSON file from disk">File...</button>
      </div>
    </div>

    <!-- 3. Viewport -->
    <div class="control-group viewport-group">
      <div class="group-label">Viewport</div>
      <div class="group-row">
        <div class="select-wrapper">
          <select class="select-box vp-select" id="viewport-select" title="Browser viewport size">
            <option value="1440x900">Desktop 1440×900</option>
            <option value="1920x1080">Desktop 1920×1080</option>
            <option value="393x851">Mobile 393×851</option>
          </select>
          <span class="select-arrow">▾</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 4. Locator inspector -->
  <div class="inspector-card" id="locator-bar">
    <div class="inspector-header">
      <div class="inspector-title-area">
        <span class="group-label">Locator inspector</span>
        <span id="locator-status" class="badge badge-idle">Waiting for locator</span>
      </div>
      <div class="inspector-actions-area">
        <button class="btn btn-clear btn-action" id="btn-clear-highlight" style="display: none;" title="Remove highlight overlay from the page and clear search results">Clear</button>
        <button class="btn btn-primary btn-action" id="btn-search-locator" title="Find and highlight locator on the current page (Enter)">Find</button>
      </div>
    </div>

    <div class="inspector-search-row">
      <textarea
        class="locator-search-input"
        id="locator-search-input"
        rows="1"
        spellcheck="false"
        placeholder="Paste locator or selector (e.g. page.getByTestId('...') or this.contentRoot)"
      ></textarea>
    </div>

    <div class="inspector-details" id="inspector-details">
      <div class="inspector-block" id="param-row" style="display: none;">
        <span class="block-badge" id="param-badge">Parameter</span>
        <div class="param-toolbar" id="param-toolbar"></div>
      </div>
      <div class="inspector-block">
        <span class="block-badge">Playwright</span>
        <div class="code-line pw-chain" id="locator-chain"></div>
      </div>
      <div class="inspector-block" id="elements-row" style="display: none;">
        <span class="block-badge">Elements</span>
        <div class="elements-toolbar" id="elements-list"></div>
      </div>
    </div>
  </div>

  <div class="viewport-host" id="viewport-host">
    <div class="empty-placeholder" id="placeholder">Launching Chromium and connecting CDP Screencast...</div>
    <img id="screen-img" tabindex="0" style="display: none;" alt="Playwright Screencast" />
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const urlInput = document.getElementById('url-input');
    const btnGo = document.getElementById('btn-go');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    const storageSelect = document.getElementById('storage-select');
    const btnBrowseStorage = document.getElementById('btn-browse-storage');
    const viewportSelect = document.getElementById('viewport-select');
    const btnClearHighlight = document.getElementById('btn-clear-highlight');
    const locatorSearchInput = document.getElementById('locator-search-input');
    const btnSearchLocator = document.getElementById('btn-search-locator');
    const screenImg = document.getElementById('screen-img');
    const placeholder = document.getElementById('placeholder');
    const locatorStatus = document.getElementById('locator-status');
    const inspectorDetails = document.getElementById('inspector-details');
    const locatorChain = document.getElementById('locator-chain');
    const paramRow = document.getElementById('param-row');
    const paramBadge = document.getElementById('param-badge');
    const paramToolbar = document.getElementById('param-toolbar');
    const elementsRow = document.getElementById('elements-row');
    const elementsList = document.getElementById('elements-list');

    let viewportWidth = 1440;
    let viewportHeight = 900;
    let lastMoveSent = 0;

    function cleanAndCompactCode(rawText) {
      if (!rawText) return '';
      let noBlockComments = rawText.replace(/\/\*[\s\S]*?\*\//g, ' ');
      const cleanLines = noBlockComments
        .split(/\r?\n/)
        .map((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//')) {
            return '';
          }
          return trimmed.replace(/(^|[^:])\/\/.*$/, '$1').trim();
        })
        .filter(Boolean);

      let joined = cleanLines.join(' ').replace(/\s+/g, ' ').trim();
      joined = joined
        .replace(/\s*\.\s*(?=[a-zA-Z_$])/g, '.')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/,\s*\}/g, ' }')
        .replace(/,\s*\)/g, ')')
        .replace(/\{\s*/g, '{ ')
        .replace(/\s*\}/g, ' }')
        .replace(/\{\s+\}/g, '{}');
      return joined.trim();
    }

    function autoResizeLocatorInput() {
      locatorSearchInput.style.height = 'auto';
      const scrollH = locatorSearchInput.scrollHeight;
      const targetH = Math.max(28, Math.min(110, scrollH));
      locatorSearchInput.style.height = targetH + 'px';
      locatorSearchInput.style.overflowY = scrollH > 110 ? 'auto' : 'hidden';
    }

    window.addEventListener('resize', () => {
      autoResizeLocatorInput();
    });

    function resetInspectorPanel(clearSearchField = false) {
      locatorStatus.textContent = 'Waiting for locator';
      locatorStatus.className = 'badge badge-idle';
      inspectorDetails.style.display = 'none';
      btnClearHighlight.style.display = 'none';
      locatorChain.textContent = '';
      paramToolbar.innerHTML = '';
      paramRow.style.display = 'none';
      elementsList.innerHTML = '';
      elementsRow.style.display = 'none';
      if (clearSearchField) {
        locatorSearchInput.value = '';
        autoResizeLocatorInput();
      }
    }

    function triggerLocatorSearch() {
      const cleaned = cleanAndCompactCode(locatorSearchInput.value);
      if (!cleaned) {
        return;
      }
      locatorSearchInput.value = cleaned;
      autoResizeLocatorInput();
      locatorStatus.textContent = 'Searching...';
      locatorStatus.className = 'badge badge-idle';
      btnClearHighlight.style.display = 'inline-flex';
      vscode.postMessage({
        type: 'searchLocatorSnippet',
        snippet: cleaned,
      });
    }

    btnSearchLocator.addEventListener('click', triggerLocatorSearch);
    locatorSearchInput.addEventListener('paste', (e) => {
      const pasted = (e.clipboardData || window.clipboardData).getData('text');
      if (pasted) {
        e.preventDefault();
        const cleaned = cleanAndCompactCode(pasted);
        const start = locatorSearchInput.selectionStart || 0;
        const end = locatorSearchInput.selectionEnd || 0;
        const current = locatorSearchInput.value;
        const isFullLocatorPaste =
          /^(page\.|this\.|const\b|let\b|var\b|await\b|expect\s*\(|\.locator\b|locator\s*\(|getBy[A-Z])/.test(
            cleaned
          ) ||
          (start === 0 && end === 0 && current.trim().length > 0);
        const nextVal = isFullLocatorPaste
          ? cleaned
          : cleanAndCompactCode(
              current.slice(0, start) + cleaned + current.slice(end)
            );
        locatorSearchInput.value = nextVal;
        autoResizeLocatorInput();
      }
    });
    locatorSearchInput.addEventListener('input', () => {
      autoResizeLocatorInput();
    });
    locatorSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        triggerLocatorSearch();
      }
    });

    function triggerNavigate() {
      const url = urlInput.value.trim();
      if (url) {
        vscode.postMessage({ type: 'navigate', url });
      }
    }

    btnGo.addEventListener('click', triggerNavigate);
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        triggerNavigate();
      }
    });

    btnBack.addEventListener('click', () => vscode.postMessage({ type: 'goBack' }));
    btnForward.addEventListener('click', () => vscode.postMessage({ type: 'goForward' }));
    btnReload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
    btnBrowseStorage.addEventListener('click', () => vscode.postMessage({ type: 'chooseStorageStateFile' }));
    btnClearHighlight.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearHighlight' });
      resetInspectorPanel(true);
    });

    storageSelect.addEventListener('change', () => {
      vscode.postMessage({
        type: 'setStorageState',
        storageStatePath: storageSelect.value,
      });
    });

    viewportSelect.addEventListener('change', () => {
      const [w, h] = viewportSelect.value.split('x').map(Number);
      if (w && h) {
        viewportWidth = w;
        viewportHeight = h;
        vscode.postMessage({ type: 'setViewport', width: w, height: h });
      }
    });

    function mapClientToViewport(clientX, clientY) {
      const rect = screenImg.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return { x: 0, y: 0 };
      }
      const x = ((clientX - rect.left) / rect.width) * viewportWidth;
      const y = ((clientY - rect.top) / rect.height) * viewportHeight;
      return { x, y };
    }

    screenImg.addEventListener('click', (e) => {
      screenImg.focus();
      const { x, y } = mapClientToViewport(e.clientX, e.clientY);
      vscode.postMessage({
        type: 'mouseEvent',
        event: { type: 'click', x, y, button: 'left' },
      });
    });

    screenImg.addEventListener('dblclick', (e) => {
      const { x, y } = mapClientToViewport(e.clientX, e.clientY);
      vscode.postMessage({
        type: 'mouseEvent',
        event: { type: 'dblclick', x, y, button: 'left' },
      });
    });

    screenImg.addEventListener('mousemove', (e) => {
      const now = Date.now();
      if (now - lastMoveSent < 35) {
        return;
      }
      lastMoveSent = now;
      const { x, y } = mapClientToViewport(e.clientX, e.clientY);
      vscode.postMessage({
        type: 'mouseEvent',
        event: { type: 'mousemove', x, y },
      });
    });

    screenImg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = mapClientToViewport(e.clientX, e.clientY);
      vscode.postMessage({
        type: 'mouseEvent',
        event: {
          type: 'wheel',
          x,
          y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
        },
      });
    }, { passive: false });

    screenImg.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey) {
        return;
      }
      e.preventDefault();
      if (e.key.length === 1) {
        vscode.postMessage({
          type: 'keyEvent',
          event: { type: 'insertText', text: e.key },
        });
      } else {
        vscode.postMessage({
          type: 'keyEvent',
          event: { type: 'press', key: e.key },
        });
      }
    });

    function formatElementSummaryText(el, totalCount) {
      if (!el) return '';
      const idx = el.index;
      const testIdPart = el.testId ? ' testId="' + el.testId + '"' : '';
      const rolePart = el.role ? ' role="' + el.role + '"' : '';
      let nthHint = '.nth(' + idx + ')';
      if (idx === 0 && totalCount > 1) {
        nthHint = '.first() / .nth(0)';
      } else if (idx === totalCount - 1 && totalCount > 1) {
        nthHint = '.last() / .nth(' + idx + ')';
      }
      const textPreviewPart = el.textPreview
        ? ' • "' + el.textPreview.slice(0, 75) + '"'
        : el.valuePreview
          ? ' • value="' + el.valuePreview.slice(0, 60) + '"'
          : '';
      return '#' + (idx + 1) + ' <' + el.tagName + testIdPart + rolePart + '> • ' + nthHint + textPreviewPart;
    }

    function renderParameterBar(paramInfo) {
      paramToolbar.innerHTML = '';
      if (!paramInfo || !Array.isArray(paramInfo.parameterNames) || paramInfo.parameterNames.length === 0) {
        paramRow.style.display = 'none';
        return;
      }
      paramRow.style.display = 'flex';
      paramBadge.textContent =
        paramInfo.parameterNames.length === 1
          ? paramInfo.parameterNames[0]
          : 'Parameters';

      const track = document.createElement('div');
      track.className = 'chips-scroll-track';
      track.style.maxWidth = '68%';

      const variants = paramInfo.variants || [];
      variants.forEach((v) => {
        const btn = document.createElement('button');
        btn.className =
          'nav-chip param-chip' + (paramInfo.activeVariantId === v.id ? ' active' : '');
        const paramVals = Object.values(v.parameters || {})
          .map((val) => JSON.stringify(val))
          .join(', ');
        btn.textContent = paramVals || v.label;
        btn.title = v.label + (v.description ? ' -> ' + v.description : '');
        btn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'selectParameterVariant',
            variantId: v.id,
          });
        });
        track.appendChild(btn);
      });
      paramToolbar.appendChild(track);

      const customGroup = document.createElement('div');
      customGroup.className = 'param-custom-group';
      const firstParam = paramInfo.parameterNames[0];
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'param-custom-input';
      input.placeholder = 'Custom value (' + firstParam + ')...';
      if (paramInfo.customValues && paramInfo.customValues[firstParam] !== undefined) {
        input.value = String(paramInfo.customValues[firstParam]);
      }
      const applyBtn = document.createElement('button');
      applyBtn.className = 'nav-chip';
      applyBtn.textContent = 'Apply';
      applyBtn.title = 'Apply custom parameter value';
      const submitCustom = () => {
        const raw = input.value.trim();
        if (!raw) return;
        const overrides = {};
        paramInfo.parameterNames.forEach((pName) => {
          overrides[pName] = raw;
        });
        vscode.postMessage({
          type: 'applyCustomParameter',
          overrides,
        });
      };
      applyBtn.addEventListener('click', submitCustom);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitCustom();
        }
      });
      customGroup.appendChild(input);
      customGroup.appendChild(applyBtn);
      paramToolbar.appendChild(customGroup);
    }

    function renderHighlight(hl) {
      if (!hl) {
        resetInspectorPanel(false);
        return;
      }
      locatorStatus.textContent = hl.statusText;
      locatorStatus.className = 'badge ' + (hl.count > 0 ? 'badge-ok' : 'badge-zero');
      inspectorDetails.style.display = 'flex';
      btnClearHighlight.style.display = 'inline-flex';
      const cleanExpr = cleanAndCompactCode(hl.expressionText || '');
      locatorChain.textContent = hl.humanReadable;
      if (cleanExpr && document.activeElement !== locatorSearchInput && !locatorSearchInput.value.trim()) {
        locatorSearchInput.value = cleanExpr;
      }
      autoResizeLocatorInput();

      renderParameterBar(hl.parameterInfo);

      elementsList.innerHTML = '';
      const els = hl.elements || [];
      if (els.length > 0) {
        elementsRow.style.display = 'flex';
        const activeIdx =
          typeof hl.activeElementIndex === 'number' ? hl.activeElementIndex : null;

        const selectWrapper = document.createElement('div');
        selectWrapper.className = 'select-wrapper elements-select-wrapper';

        const selectEl = document.createElement('select');
        selectEl.className = 'select-box elements-select';
        selectEl.id = 'elements-select';
        selectEl.title = 'Select match to highlight and scroll in browser';

        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = 'All matches (' + els.length + ') — highlight all';
        selectEl.appendChild(allOpt);

        els.forEach((el) => {
          const opt = document.createElement('option');
          opt.value = String(el.index);
          opt.textContent = formatElementSummaryText(el, els.length);
          selectEl.appendChild(opt);
        });

        selectEl.value = activeIdx !== null ? String(activeIdx) : '';
        selectEl.addEventListener('change', () => {
          const val = selectEl.value;
          const nextIdx = val === '' ? null : Number(val);
          vscode.postMessage({ type: 'focusElement', index: nextIdx });
        });

        const selectArrow = document.createElement('span');
        selectArrow.className = 'select-arrow';
        selectArrow.textContent = '▾';

        selectWrapper.appendChild(selectEl);
        selectWrapper.appendChild(selectArrow);
        elementsList.appendChild(selectWrapper);

        const prevBtn = document.createElement('button');
        prevBtn.className = 'nav-chip';
        prevBtn.id = 'btn-prev-element';
        prevBtn.textContent = '‹';
        prevBtn.title = 'Previous element';
        prevBtn.addEventListener('click', () => {
          const nextIdx =
            activeIdx === null
              ? els.length - 1
              : (activeIdx - 1 + els.length) % els.length;
          vscode.postMessage({ type: 'focusElement', index: nextIdx });
        });
        elementsList.appendChild(prevBtn);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'nav-chip';
        nextBtn.id = 'btn-next-element';
        nextBtn.textContent = '›';
        nextBtn.title = 'Next element';
        nextBtn.addEventListener('click', () => {
          const nextIdx =
            activeIdx === null ? 0 : (activeIdx + 1) % els.length;
          vscode.postMessage({ type: 'focusElement', index: nextIdx });
        });
        elementsList.appendChild(nextBtn);
      } else {
        elementsRow.style.display = 'none';
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'screencastFrame') {
        const { data, deviceWidth, deviceHeight, pageUrl } = msg.payload;
        if (deviceWidth && deviceHeight) {
          viewportWidth = deviceWidth;
          viewportHeight = deviceHeight;
        }
        placeholder.style.display = 'none';
        screenImg.style.display = 'block';
        screenImg.src = 'data:image/jpeg;base64,' + data;
        if (pageUrl && document.activeElement !== urlInput) {
          urlInput.value = pageUrl;
        }
      } else if (msg.type === 'state') {
        const st = msg.payload;
        if (st.currentUrl && document.activeElement !== urlInput && st.currentUrl !== 'about:blank') {
          urlInput.value = st.currentUrl;
        }
        if (st.viewport) {
          viewportWidth = st.viewport.width;
          viewportHeight = st.viewport.height;
          const vpKey = st.viewport.width + 'x' + st.viewport.height;
          if ([...viewportSelect.options].some((o) => o.value === vpKey)) {
            viewportSelect.value = vpKey;
          }
        }
        if (Array.isArray(st.availableStorageStates)) {
          const currentVal = st.storageStatePath || '';
          storageSelect.innerHTML = '<option value="">No auth (clean session)</option>';
          st.availableStorageStates.forEach((cand) => {
            const opt = document.createElement('option');
            opt.value = cand.fullPath;
            opt.textContent = cand.label;
            opt.title = cand.relativePath + ' (cookies: ' + cand.cookiesCount + ', origins: ' + cand.originsCount + ')';
            storageSelect.appendChild(opt);
          });
          if (currentVal && ![...storageSelect.options].some((o) => o.value === currentVal)) {
            const customOpt = document.createElement('option');
            customOpt.value = currentVal;
            customOpt.textContent = currentVal.split(/[\\/]/).slice(-2).join('/');
            storageSelect.appendChild(customOpt);
          }
          storageSelect.value = currentVal;
        }
        renderHighlight(st.lastHighlight);
      } else if (msg.type === 'highlightResult') {
        renderHighlight(msg.payload);
      } else if (msg.type === 'setSearchInput') {
        const text = cleanAndCompactCode((msg.payload && msg.payload.expressionText) || '');
        locatorSearchInput.value = text;
        autoResizeLocatorInput();
      } else if (msg.type === 'searchError') {
        const errText = (msg.payload && msg.payload.message) || 'Failed to parse locator';
        locatorStatus.textContent = errText;
        locatorStatus.className = 'badge badge-zero';
        btnClearHighlight.style.display = 'inline-flex';
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
