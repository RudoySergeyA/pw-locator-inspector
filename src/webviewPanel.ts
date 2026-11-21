import * as vscode from 'vscode';
import {
  BrowserManager,
  BrowserStateSnapshot,
  HighlightLocatorResult,
  ScreencastFramePayload,
} from './browserManager';

export type SearchLocatorSnippetHandler = (snippet: string) => Promise<void>;
export type SelectParameterVariantHandler = (variantId: string) => Promise<void>;

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
  private historyProject?: string;
  private readonly workspaceState: vscode.Memento;

  private postHistory(projectRoot: string): void {
    const urls = this.workspaceState.get<string[]>(`navigationHistory:${projectRoot}`, []);
    void this.panel.webview.postMessage({ type: 'navigationHistory', payload: { urls } });
  }

  private async updateHistory(projectRoot: string, visited?: string[]): Promise<void> {
    const key = `navigationHistory:${projectRoot}`;
    let urls = visited ? this.workspaceState.get<string[]>(key, []) : [];
    for (const value of visited ?? []) {
      let url: URL;
      try { url = new URL(value); } catch { continue; }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
          /(?:[?&#]|^)[^=&#]*(?:token|secret|pass(?:word)?|credential|session|auth|api[_-]?key)[^=&#]*=/i.test(url.search + url.hash) ||
          /(?:[?&#]|^)code=/i.test(url.search + url.hash)) continue;
      const address = url.href;
      urls = [address, ...urls.filter((entry) => entry !== address)].slice(0, 5);
    }
    await this.workspaceState.update(key, urls);
    if (this.historyProject === projectRoot) this.postHistory(projectRoot);
  }
  private onSearchLocatorSnippet?: SearchLocatorSnippetHandler;
  private onSelectParameterVariant?: SelectParameterVariantHandler;

  public static async createOrShow(
    context: vscode.ExtensionContext,
    browserManager: BrowserManager,
    options?: {
      activeFilePath?: string;
      workspaceRoot?: string;
      storageStatePath?: string;
      viewport?: { width: number; height: number };
      readEnvFiles?: boolean;
      onSearchLocatorSnippet?: SearchLocatorSnippetHandler;
      onSelectParameterVariant?: SelectParameterVariantHandler;
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
      context.workspaceState,
      options?.onSearchLocatorSnippet,
      options?.onSelectParameterVariant
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
    workspaceState: vscode.Memento,
    onSearchLocatorSnippet?: SearchLocatorSnippetHandler,
    onSelectParameterVariant?: SelectParameterVariantHandler
  ) {
    this.panel = panel;
    this.browserManager = browserManager;
    this.workspaceState = workspaceState;
    this.onSearchLocatorSnippet = onSearchLocatorSnippet;
    this.onSelectParameterVariant = onSelectParameterVariant;

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
    const onVisit = (projectRoot: string, urls: string[]) => {
      void this.updateHistory(projectRoot, urls).catch(() => {
        vscode.window.showErrorMessage('Playwright Browser Inspector: could not save navigation history.');
      });
    };
    this.browserManager.on('navigationVisited', onVisit);

    this.disposables.push(
      new vscode.Disposable(() => {
        this.browserManager.off('screencastFrame', onFrame);
        this.browserManager.off('stateChanged', onState);
        this.browserManager.off('highlightChanged', onHighlight);
        this.browserManager.off('navigationVisited', onVisit);
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
    if (state.isRunning && this.historyProject !== state.projectRoot) {
      this.historyProject = state.projectRoot;
      this.postHistory(state.projectRoot);
    }
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
          if (this.historyProject) this.postHistory(this.historyProject);
          break;
        case 'clearNavigationHistory':
          if (this.historyProject) await this.updateHistory(this.historyProject);
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
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: stretch;
      gap: 8px;
      padding: 8px 10px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
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
      min-width: 0;
    }
    .control-group.nav-group {
      grid-column: 1 / -1;
    }
    .page-spinner {
      width: 32px;
      height: 32px;
      margin: auto;
      border: 3px solid var(--muted);
      border-top-color: var(--accent-link);
      border-radius: 50%;
      animation: page-spin 0.8s linear infinite;
    }
    @keyframes page-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .page-spinner { animation: none; }
    }
    .auth-group .select-wrapper,
    .viewport-group .select-wrapper {
      flex: 1;
      min-width: 0;
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
    body {
      --primary-border: rgba(56, 189, 248, 0.45);
    }
    body.vscode-light,
    body.vscode-high-contrast-light {
      --primary-border: rgba(2, 132, 199, 0.45);
    }
    .btn-primary {
      background: rgba(56, 189, 248, 0.14);
      border-color: var(--primary-border);
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
      border-color: var(--primary-border);
      color: #0369a1;
    }
    body.vscode-light .btn-clear,
    body.vscode-high-contrast-light .btn-clear {
      background: rgba(220, 38, 38, 0.1);
      border-color: rgba(220, 38, 38, 0.35);
      color: #b91c1c;
    }
    #btn-go,
    #btn-history,
    #btn-browse-storage,
    #btn-clear-highlight,
    #btn-search-locator {
      flex: none;
      width: 64px;
    }
    #btn-back,
    #btn-forward,
    #btn-reload {
      flex: none;
      width: 32px;
    }

    .url-input {
      flex: 1;
      min-width: 0;
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
    .locator-search-input::placeholder {
      color: var(--input-placeholder);
    }
    .nav-group.is-new:has(.url-input:placeholder-shown) {
      background: color-mix(in srgb, var(--card-bg) 96%, var(--accent));
      border-color: color-mix(in srgb, var(--border) 65%, var(--accent));
    }
    .nav-group.is-new .url-input:placeholder-shown {
      background: color-mix(in srgb, var(--input-bg) 94%, var(--accent));
      border-color: color-mix(in srgb, var(--border-light) 55%, var(--accent));
    }
    .nav-group .url-input:focus {
      border-color: var(--accent);
    }
    .navigation-error {
      color: var(--vscode-errorForeground, #f87171);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .history-control {
      position: relative;
      flex: none;
    }
    .history-popover,
    .select-popover {
      position: absolute;
      z-index: 2;
      top: calc(100% + 4px);
      padding: 6px;
      border: 1px solid var(--border-light);
      border-radius: 6px;
      background: var(--card-bg);
      box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }
    .history-popover {
      right: 0;
      width: 320px;
      max-width: calc(100vw - 38px);
    }
    .select-popover {
      left: 0;
      width: max(100%, 200px);
      max-width: calc(100vw - 38px);
      max-height: min(220px, 40vh);
      overflow: auto;
    }
    .viewport-group .select-popover {
      left: auto;
      right: 0;
    }
    .elements-select-wrapper .select-popover,
    .param-select-wrapper .select-popover {
      position: fixed;
      z-index: 10;
      box-sizing: border-box;
      max-width: none;
    }
    .select-option {
      display: block;
      width: 100%;
      min-height: 28px;
      height: auto;
      padding-block: 5px;
      white-space: normal;
      overflow-wrap: anywhere;
      text-align: left;
    }
    .select-option + .select-option {
      margin-top: 3px;
    }
    .select-option[aria-selected="true"] {
      background: var(--btn-hover-bg);
      border-color: var(--accent);
    }
    #elements-options .select-option[aria-selected="true"],
    #param-options .select-option[aria-selected="true"] {
      border-color: var(--border-light);
    }
    .select-popover .select-option:hover,
    #elements-options .select-option:hover,
    #param-options .select-option:hover,
    #history-entries .history-entry:hover {
      border-color: var(--primary-border);
      box-shadow: inset 0 0 0 1px var(--primary-border);
      transition: background 0.15s;
    }
    #elements-options .select-option,
    #param-options .select-option {
      transition: background 0.15s;
    }
    .select-option:focus-visible {
      outline: 1px solid var(--accent);
      outline-offset: 1px;
    }
    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    #history-entries {
      max-height: min(220px, 40vh);
      overflow: auto;
    }
    .history-entry {
      display: block;
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
      margin-top: 3px;
    }
    .history-empty {
      padding: 5px 4px;
      color: var(--muted);
      font-size: 12px;
    }

    .select-wrapper {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .select-box {
      width: 100%;
      min-width: 0;
      text-align: left;
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
    .select-box:enabled:hover,
    #btn-history:hover {
      border-color: var(--primary-border);
      box-shadow: inset 0 0 0 1px var(--primary-border);
    }
    .select-box:focus-visible {
      border-color: var(--accent);
    }
    #elements-select:disabled,
    #param-select:disabled {
      cursor: default;
    }
    #elements-select:disabled + .select-arrow,
    #param-select:disabled + .select-arrow {
      visibility: hidden;
    }
    .select-arrow {
      position: absolute;
      right: 9px;
      pointer-events: none;
      color: var(--muted);
      font-size: 16px;
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
      display: flex;
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
      width: 88px;
      max-width: 88px;
      display: block;
      height: 20px;
      line-height: 18px;
      padding: 0 6px;
      border-radius: 4px;
      background: var(--panel-bg);
      border: 1px solid var(--border-light);
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
      min-height: 24px;
      line-height: 24px;
      overflow-y: hidden;
      color: var(--code-pw);
    }
    .code-line.pw-chain.has-horizontal-scroll {
      min-height: 34px;
      line-height: 1.5;
      padding-top: 2px;
      padding-bottom: 12px;
    }

    .param-toolbar,
    .elements-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
      overflow: visible;
    }
    #param-row,
    #elements-row {
      overflow: visible;
    }
    .select-wrapper.elements-select-wrapper,
    .select-wrapper.param-select-wrapper {
      flex: 1 1 0%;
      width: 0;
      min-width: 0;
      max-width: 100%;
      display: flex;
    }
    .select-box.elements-select,
    .select-box.param-select {
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

    .viewport-host {
      flex: 1;
      display: flex;
      align-items: center;
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
    <div class="control-group nav-group is-new" id="navigation">
      <div class="group-label">Navigation</div>
      <div class="group-row">
        <button class="btn" id="btn-back" title="Back">←</button>
        <button class="btn" id="btn-forward" title="Forward">→</button>
        <button class="btn" id="btn-reload" title="Reload page">↻</button>
        <input class="url-input" id="url-input" type="text" aria-label="URL" aria-describedby="navigation-error" placeholder="Enter a URL to check the locator" />
        <button class="btn btn-primary" id="btn-go" title="Navigate to URL">Go</button>
        <div class="history-control" id="history-control">
          <button class="btn" id="btn-history" aria-expanded="false" aria-controls="history-popover">History</button>
          <div class="history-popover" id="history-popover" role="region" aria-label="Navigation history" hidden>
            <div class="history-header">
              <span class="group-label">Navigation history</span>
              <button class="btn btn-action" id="btn-clear-history" aria-label="Clear navigation history">Clear</button>
            </div>
            <div id="history-entries"><div class="history-empty">No navigation history</div></div>
          </div>
        </div>
      </div>
      <div class="navigation-error" id="navigation-error" role="alert" hidden></div>
    </div>

    <!-- 2. Viewport -->
    <div class="control-group viewport-group">
      <div class="group-label">Viewport</div>
      <div class="group-row">
        <div class="select-wrapper">
          <button type="button" class="select-box" id="viewport-select" aria-label="Viewport" aria-haspopup="listbox" aria-expanded="false" aria-controls="viewport-options" aria-describedby="viewport-value"><span id="viewport-value">Desktop 1440×900</span></button>
          <span class="select-arrow" aria-hidden="true">▾</span>
          <div class="select-popover" id="viewport-options" role="listbox" aria-label="Viewport" hidden></div>
        </div>
      </div>
    </div>

    <!-- 3. Auth session (storageState) -->
    <div class="control-group auth-group">
      <div class="group-label">Auth session</div>
      <div class="group-row">
        <div class="select-wrapper">
          <button type="button" class="select-box" id="storage-select" aria-label="Auth session" aria-haspopup="listbox" aria-expanded="false" aria-controls="storage-options" aria-describedby="storage-value"><span id="storage-value">No auth (clean session)</span></button>
          <span class="select-arrow" aria-hidden="true">▾</span>
          <div class="select-popover" id="storage-options" role="listbox" aria-label="Auth session" hidden></div>
        </div>
        <button class="btn" id="btn-browse-storage" title="Load another storageState JSON file from disk">File</button>
      </div>
    </div>

  </div>

  <!-- 4. Locator inspector -->
  <div class="inspector-card" id="locator-bar">
    <div class="inspector-header">
      <div class="inspector-title-area">
        <span class="group-label">Locator inspector</span>
        <span id="locator-status" class="badge badge-idle" role="status">Waiting for page</span>
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
      <div class="inspector-block" id="param-row">
        <span class="block-badge" id="param-badge" title="Parameter">Parameter</span>
        <div class="param-toolbar" id="param-toolbar">
          <div class="select-wrapper param-select-wrapper">
            <button type="button" class="select-box param-select" id="param-select" disabled aria-label="Parameter" aria-haspopup="listbox" aria-expanded="false" aria-controls="param-options" aria-describedby="param-value"><span id="param-value"></span></button>
            <span class="select-arrow" aria-hidden="true">▾</span>
            <div class="select-popover" id="param-options" role="listbox" aria-label="Parameter" hidden></div>
          </div>
        </div>
      </div>
      <div class="inspector-block">
        <span class="block-badge">Playwright</span>
        <div class="code-line pw-chain" id="locator-chain"></div>
      </div>
      <div class="inspector-block" id="elements-row">
        <span class="block-badge">Elements</span>
        <div class="elements-toolbar" id="elements-list">
          <div class="select-wrapper elements-select-wrapper">
            <button type="button" class="select-box elements-select" id="elements-select" disabled aria-label="Elements" aria-haspopup="listbox" aria-expanded="false" aria-controls="elements-options" aria-describedby="elements-value"><span id="elements-value"></span></button>
            <span class="select-arrow" aria-hidden="true">▾</span>
            <div class="select-popover" id="elements-options" role="listbox" aria-label="Elements" hidden></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="viewport-host" id="viewport-host">
    <div class="empty-placeholder" id="placeholder">Waiting for navigation</div>
    <div class="page-spinner" id="page-spinner" role="progressbar" aria-label="Loading page" hidden></div>
    <img id="screen-img" tabindex="0" style="display: none;" alt="Playwright Screencast" />
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const urlInput = document.getElementById('url-input');
    const navigation = document.getElementById('navigation');
    const navigationError = document.getElementById('navigation-error');
    const historyControl = document.getElementById('history-control');
    const historyPopover = document.getElementById('history-popover');
    const historyEntries = document.getElementById('history-entries');
    const btnHistory = document.getElementById('btn-history');
    const btnClearHistory = document.getElementById('btn-clear-history');
    const btnGo = document.getElementById('btn-go');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    const btnBrowseStorage = document.getElementById('btn-browse-storage');
    const btnClearHighlight = document.getElementById('btn-clear-highlight');
    const locatorSearchInput = document.getElementById('locator-search-input');
    const btnSearchLocator = document.getElementById('btn-search-locator');
    const screenImg = document.getElementById('screen-img');
    const placeholder = document.getElementById('placeholder');
    const locatorStatus = document.getElementById('locator-status');
    const pageSpinner = document.getElementById('page-spinner');
    const locatorChain = document.getElementById('locator-chain');
    const paramBadge = document.getElementById('param-badge');
    const paramButton = document.getElementById('param-select');
    const elementsButton = document.getElementById('elements-select');

    let viewportWidth = 1440;
    let viewportHeight = 900;
    let lastMoveSent = 0;
    let pageReady = false;
    let currentUrl = '';
    let hasNavigated = false;
    let hasUrlDraft = false;
    let submittedUrl = '';
    let navigationWasPending = false;
    let navigationLoading = false;
    let resettingUrl = false;

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
      // Длинный плейсхолдер не должен менять высоту пустого поля.
      const scrollH = locatorSearchInput.value ? locatorSearchInput.scrollHeight : 28;
      const targetH = Math.max(28, Math.min(110, scrollH));
      locatorSearchInput.style.height = targetH + 'px';
      locatorSearchInput.style.overflowY = scrollH > 110 ? 'auto' : 'hidden';
    }

    function syncLocatorChainLayout() {
      const hasOverflow =
        Boolean(locatorChain.textContent) &&
        locatorChain.scrollWidth > locatorChain.clientWidth + 1;
      if (locatorChain.classList.contains('has-horizontal-scroll') !== hasOverflow) {
        locatorChain.classList.toggle('has-horizontal-scroll', hasOverflow);
      }
    }

    new ResizeObserver(syncLocatorChainLayout).observe(locatorChain);

    window.addEventListener('resize', () => {
      autoResizeLocatorInput();
      syncLocatorChainLayout();
    });

    function resetInspectorPanel(clearSearchField = false) {
      locatorStatus.textContent = pageReady ? 'Waiting for locator' : 'Waiting for page';
      locatorStatus.className = 'badge badge-idle';
      btnClearHighlight.style.display = 'none';
      locatorChain.textContent = '';
      syncLocatorChainLayout();
      renderParameterBar(null);
      renderElements([], null);
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
      locatorStatus.textContent = pageReady ? 'Searching...' : 'Waiting for page';
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

    function showNavigationError(message) {
      if (navigationError.textContent !== message) navigationError.textContent = message;
      navigationError.hidden = !message;
      if (message) urlInput.setAttribute('aria-invalid', 'true');
      else urlInput.removeAttribute('aria-invalid');
    }

    function navigateTo(url) {
      if (!url) return;
      resettingUrl = false;
      hasUrlDraft = true;
      submittedUrl = url;
      navigationWasPending = false;
      showNavigationError('');
      vscode.postMessage({ type: 'navigate', url });
    }

    function triggerNavigate() {
      navigateTo(urlInput.value.trim());
    }

    function setHistoryOpen(open, restoreFocus = false) {
      historyPopover.hidden = !open;
      btnHistory.setAttribute('aria-expanded', String(open));
      if (restoreFocus) btnHistory.focus();
    }

    function renderNavigationHistory(urls) {
      const focusedEntry = historyEntries.contains(document.activeElement)
        ? document.activeElement.title : '';
      historyEntries.replaceChildren();
      if (!urls.length) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = 'No navigation history';
        historyEntries.appendChild(empty);
      }
      let nextFocus;
      urls.forEach((url) => {
        const entry = document.createElement('button');
        entry.className = 'btn history-entry';
        entry.textContent = url;
        entry.title = url;
        entry.setAttribute('aria-label', url);
        entry.addEventListener('click', () => {
          setHistoryOpen(false, true);
          urlInput.value = url;
          navigateTo(url);
        });
        historyEntries.appendChild(entry);
        if (url === focusedEntry) nextFocus = entry;
      });
      if (focusedEntry && !historyPopover.hidden) (nextFocus || btnClearHistory).focus();
    }

    btnHistory.addEventListener('click', () => setHistoryOpen(historyPopover.hidden));
    btnClearHistory.addEventListener('click', () => vscode.postMessage({ type: 'clearNavigationHistory' }));
    document.addEventListener('click', (e) => {
      if (!historyPopover.hidden && !historyControl.contains(e.target)) setHistoryOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !historyPopover.hidden) {
        e.preventDefault();
        e.stopPropagation();
        setHistoryOpen(false, historyPopover.contains(document.activeElement));
      }
    }, true);

    btnGo.addEventListener('click', triggerNavigate);
    urlInput.addEventListener('input', () => {
      const hadNavigation = Boolean(currentUrl || submittedUrl || navigationLoading);
      hasUrlDraft = true;
      submittedUrl = '';
      if (urlInput.value.trim() || resettingUrl || !hadNavigation) return;
      resettingUrl = true;
      pageReady = false;
      currentUrl = '';
      navigationLoading = false;
      showNavigationError('');
      screenImg.removeAttribute('src');
      resetInspectorPanel();
      updateScreen();
      vscode.postMessage({ type: 'navigate', url: 'about:blank' });
    });
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

    let openSelect;

    function createSelect(id, onSelect) {
      const trigger = document.getElementById(id);
      const wrapper = trigger.parentElement;
      const listbox = document.getElementById(trigger.getAttribute('aria-controls'));
      const label = document.getElementById(trigger.getAttribute('aria-describedby'));
      let options = [];
      let renderedOptions;
      let value;

      function showValue(nextValue) {
        value = nextValue;
        const current = options.find((option) => option.value === value);
        label.textContent = current ? current.label : '';
        trigger.title = current ? current.title || current.label : '';
        for (const option of listbox.children) {
          option.setAttribute('aria-selected', String(option.value === value));
        }
      }

      const isFixedPopover = trigger.id === 'elements-select' || trigger.id === 'param-select';

      function positionPopover() {
        if (!isFixedPopover || listbox.hidden) return;
        const rect = trigger.getBoundingClientRect();
        const top = rect.bottom + 4;
        listbox.style.top = top + 'px';
        listbox.style.left = rect.left + 'px';
        listbox.style.width = rect.width + 'px';
        listbox.style.maxHeight = Math.max(0, Math.min(220, window.innerHeight - top - 8)) + 'px';
      }

      function focusOption(option) {
        option.focus({ preventScroll: true });
        if (option === trigger) return;
        const optionRect = option.getBoundingClientRect();
        const menuTop = listbox.getBoundingClientRect().top + listbox.clientTop;
        const menuBottom = menuTop + listbox.clientHeight;
        if (optionRect.top < menuTop) listbox.scrollTop += optionRect.top - menuTop;
        else if (optionRect.bottom > menuBottom) listbox.scrollTop += optionRect.bottom - menuBottom;
      }

      function close(restoreFocus = false) {
        listbox.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (openSelect === control) openSelect = undefined;
        if (restoreFocus) trigger.focus({ preventScroll: true });
      }

      function open(fromEnd = false) {
        if (!options.length) return;
        if (openSelect) openSelect.close();
        if (!historyPopover.hidden) setHistoryOpen(false);
        openSelect = control;
        listbox.hidden = false;
        positionPopover();
        trigger.setAttribute('aria-expanded', 'true');
        const current = listbox.querySelector('[aria-selected="true"]');
        focusOption(current || (fromEnd ? listbox.lastElementChild : listbox.firstElementChild));
      }

      function update(nextOptions, nextValue) {
        const signature = JSON.stringify(nextOptions);
        const focused = listbox.contains(document.activeElement) ? document.activeElement : null;
        if (signature !== renderedOptions) {
          options = nextOptions;
          renderedOptions = signature;
          listbox.replaceChildren(...options.map((item) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'btn select-option';
            option.setAttribute('role', 'option');
            option.tabIndex = -1;
            option.value = item.value;
            option.textContent = item.label;
            option.title = item.title || item.label;
            option.addEventListener('click', () => {
              const changed = item.value !== value;
              showValue(item.value);
              close(true);
              if (changed) onSelect(item.value);
            });
            return option;
          }));
        }
        showValue(nextValue);
        positionPopover();
        if (!listbox.hidden && focused && !listbox.contains(focused)) {
          const nextFocus = Array.from(listbox.children).find((option) => option.value === focused.value);
          focusOption(nextFocus || listbox.querySelector('[aria-selected="true"]') || listbox.firstElementChild || trigger);
        }
      }

      const control = { wrapper, close, update };
      if (isFixedPopover) {
        new ResizeObserver(positionPopover).observe(trigger);
        window.addEventListener('resize', positionPopover);
      }
      trigger.addEventListener('click', () => listbox.hidden ? open() : close(true));
      trigger.addEventListener('keydown', (e) => {
        if (listbox.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          open(e.key === 'ArrowUp');
        }
      });
      listbox.addEventListener('keydown', (e) => {
        let next;
        if (e.key === 'ArrowDown') next = e.target.nextElementSibling || e.target;
        else if (e.key === 'ArrowUp') next = e.target.previousElementSibling || e.target;
        else if (e.key === 'Home') next = listbox.firstElementChild;
        else if (e.key === 'End') next = listbox.lastElementChild;
        else return;
        e.preventDefault();
        focusOption(next);
      });
      return control;
    }

    document.addEventListener('click', (e) => {
      if (openSelect && !openSelect.wrapper.contains(e.target)) openSelect.close();
    });
    document.addEventListener('focusin', (e) => {
      if (openSelect && !openSelect.wrapper.contains(e.target)) openSelect.close();
    });
    document.addEventListener('keydown', (e) => {
      if (openSelect && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        openSelect.close(true);
      }
    }, true);

    const noAuthOption = { value: '', label: 'No auth (clean session)' };
    const storageSelect = createSelect('storage-select', (storageStatePath) => {
      vscode.postMessage({ type: 'setStorageState', storageStatePath });
    });
    storageSelect.update([noAuthOption], '');

    const viewportOptions = [
      { value: '1440x900', label: 'Desktop 1440×900' },
      { value: '1920x1080', label: 'Desktop 1920×1080' },
      { value: '393x851', label: 'Mobile 393×851' },
    ];
    const viewportSelect = createSelect('viewport-select', (value) => {
      const [w, h] = value.split('x').map(Number);
      if (w && h) {
        viewportWidth = w;
        viewportHeight = h;
        vscode.postMessage({ type: 'setViewport', width: w, height: h });
      }
    });
    viewportSelect.update(viewportOptions, '1440x900');

    const paramSelect = createSelect('param-select', (variantId) => {
      vscode.postMessage({ type: 'selectParameterVariant', variantId });
    });

    const elementsSelect = createSelect('elements-select', (value) => {
      vscode.postMessage({ type: 'focusElement', index: value === '' ? null : Number(value) });
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

    function formatElementSummaryText(el) {
      const description = el.textPreview || el.imageAlt || el.nameAttr || el.testId || el.role || el.tagName;
      const number = String(el.index + 1);
      return description ? number + ' — ' + description : number;
    }

    function renderParameterBar(paramInfo) {
      if (!paramInfo || !Array.isArray(paramInfo.parameterNames) || paramInfo.parameterNames.length === 0) {
        paramBadge.textContent = 'Parameter';
        paramBadge.title = 'Parameter';
        paramButton.disabled = true;
        paramSelect.close();
        paramSelect.update([], '');
        return;
      }

      const badgeLabel =
        paramInfo.parameterNames.length === 1
          ? paramInfo.parameterNames[0]
          : 'Parameters';
      paramBadge.textContent = badgeLabel;
      paramBadge.title = paramInfo.parameterNames.join(', ');

      const variants = paramInfo.variants || [];
      if (variants.length > 0) {
        const options = variants.map((v) => {
          const paramVals = Object.values(v.parameters || {})
            .map((val) => JSON.stringify(val))
            .join(', ');
          return {
            value: v.id,
            label: paramVals || v.label,
            title: v.label + (v.description ? ' -> ' + v.description : ''),
          };
        });
        paramButton.disabled = false;
        paramSelect.update(options, paramInfo.activeVariantId || '');
      } else {
        paramButton.disabled = true;
        paramSelect.close();
        paramSelect.update([], '');
      }
    }

    function renderHighlight(hl) {
      const waiting = !pageReady || Boolean(hl && hl.waitingForPage);
      const cleanExpr = cleanAndCompactCode(hl && hl.expressionText || '');
      if (cleanExpr && !locatorSearchInput.value.trim() && (waiting || document.activeElement !== locatorSearchInput)) {
        locatorSearchInput.value = cleanExpr;
        autoResizeLocatorInput();
      }
      if (!hl || waiting) {
        resetInspectorPanel(false);
        if (waiting) locatorStatus.textContent = 'Waiting for page';
        return;
      }
      locatorStatus.textContent = hl.statusText;
      locatorStatus.className = 'badge ' + (hl.count > 0 ? 'badge-ok' : 'badge-zero');
      btnClearHighlight.style.display = 'inline-flex';
      locatorChain.textContent = hl.humanReadable;
      syncLocatorChainLayout();
      autoResizeLocatorInput();

      renderParameterBar(hl.parameterInfo);

      renderElements(hl.elements || [], typeof hl.activeElementIndex === 'number' ? hl.activeElementIndex : null, hl.combinedHumanReadable || hl.humanReadable);
    }

    function renderElements(els, activeIdx, locatorText) {
      elementsButton.disabled = !els.length;
      if (!els.length) {
        elementsSelect.close();
        elementsSelect.update([], '');
        return;
      }

      const options = [
        { value: '', label: 'All matches (' + els.length + ') — highlight all' },
        ...els.map((el) => ({
          value: String(el.index),
          label: formatElementSummaryText(el),
          title: locatorText ? locatorText + '.nth(' + el.index + ')' : undefined,
        })),
      ];
      elementsSelect.update(options, activeIdx === null ? '' : String(activeIdx));
    }

    function updateScreen() {
      const showFrame = !navigationLoading && pageReady && Boolean(currentUrl) && screenImg.hasAttribute('src');
      const waitingText = currentUrl ? 'Waiting for page' : 'Waiting for navigation';
      if (placeholder.textContent !== waitingText) placeholder.textContent = waitingText;
      placeholder.hidden = showFrame || navigationLoading;
      pageSpinner.hidden = !navigationLoading;
      screenImg.style.display = showFrame ? 'block' : 'none';
    }

    function updateNavigationState(st) {
      if (resettingUrl) {
        if (st.currentUrl !== 'about:blank' || st.navigationLoading) return;
        resettingUrl = false;
        hasUrlDraft = Boolean(urlInput.value.trim());
      }
      navigationLoading = st.navigationLoading === true;
      const previousUrl = currentUrl;
      currentUrl = st.currentUrl === 'about:blank' ? '' : (st.currentUrl || '');
      const ready = st.pageReady === true;
      if (pageReady && !ready) screenImg.removeAttribute('src');
      pageReady = ready;
      if (currentUrl) hasNavigated = true;
      navigation.classList.toggle('is-new', !hasNavigated);
      showNavigationError(st.navigationError || '');

      if (submittedUrl) {
        if (st.navigationError) submittedUrl = '';
        else if (!pageReady) navigationWasPending = true;
        else if (currentUrl && (navigationWasPending || currentUrl !== previousUrl || currentUrl === submittedUrl)) {
          hasUrlDraft = false;
          submittedUrl = '';
        }
      }
      if (pageReady && currentUrl && !hasUrlDraft && !st.navigationError && urlInput.value !== currentUrl) {
        urlInput.value = currentUrl;
      }
      updateScreen();
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'screencastFrame') {
        const { data, deviceWidth, deviceHeight, pageUrl } = msg.payload;
        if (resettingUrl || pageUrl === 'about:blank') return;
        if (deviceWidth && deviceHeight) {
          viewportWidth = deviceWidth;
          viewportHeight = deviceHeight;
        }
        screenImg.src = 'data:image/jpeg;base64,' + data;
        updateScreen();
      } else if (msg.type === 'navigationHistory') {
        renderNavigationHistory(msg.payload.urls);
      } else if (msg.type === 'state') {
        const st = msg.payload;
        updateNavigationState(st);
        if (st.viewport) {
          viewportWidth = st.viewport.width;
          viewportHeight = st.viewport.height;
          const vpKey = st.viewport.width + 'x' + st.viewport.height;
          const options = viewportOptions.some((option) => option.value === vpKey)
            ? viewportOptions
            : [...viewportOptions, { value: vpKey, label: st.viewport.width + '×' + st.viewport.height }];
          viewportSelect.update(options, vpKey);
        }
        if (Array.isArray(st.availableStorageStates)) {
          const currentVal = st.storageStatePath || '';
          const options = [noAuthOption, ...st.availableStorageStates.map((cand) => ({
            value: cand.fullPath,
            label: cand.label,
            title: cand.relativePath + ' (cookies: ' + cand.cookiesCount + ', origins: ' + cand.originsCount + ')',
          }))];
          if (currentVal && !options.some((option) => option.value === currentVal)) {
            options.push({ value: currentVal, label: currentVal.split(/[\\/]/).slice(-2).join('/'), title: currentVal });
          }
          storageSelect.update(options, currentVal);
        }
        renderHighlight(st.lastHighlight);
      } else if (msg.type === 'highlightResult') {
        renderHighlight(msg.payload);
      } else if (msg.type === 'setSearchInput') {
        const text = cleanAndCompactCode((msg.payload && msg.payload.expressionText) || '');
        locatorSearchInput.value = text;
        autoResizeLocatorInput();
      } else if (msg.type === 'searchError') {
        if (!pageReady) return;
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
