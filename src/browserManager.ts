import { EventEmitter } from 'events';
import {
  LocatorDescriptor,
  materializeLocator,
} from './locatorAstResolver';
import {
  discoverStorageStateFiles,
  isValidPlaywrightStorageStateFile,
  resolveWorkspacePlaywright,
  StorageStateCandidate,
  WorkspacePlaywrightRuntime,
} from './workspacePlaywright';

export interface HighlightedElementInfo {
  index: number;
  tagName: string;
  id: string;
  testId: string;
  role: string;
  nameAttr: string;
  typeAttr: string;
  textPreview: string;
  imageAlt?: string;
  valuePreview: string;
  visible: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface HighlightParameterVariantInfo {
  id: string;
  label: string;
  description?: string;
  parameters: Record<string, unknown>;
  descriptor: LocatorDescriptor;
}

export interface HighlightParameterInfo {
  baseExpressionText: string;
  parameterNames: string[];
  activeVariantId?: string;
  variants: HighlightParameterVariantInfo[];
}

export interface HighlightLocatorResult {
  count: number;
  visibleCount: number;
  elements: HighlightedElementInfo[];
  statusText: string;
  waitingForPage?: boolean;
  expressionText: string;
  humanReadable: string;
  combinedHumanReadable?: string;
  strippedActionMethod?: string;
  activeElementIndex?: number | null;
  parameterInfo?: HighlightParameterInfo;
}

export interface ScreencastFramePayload {
  data: string;
  deviceWidth: number;
  deviceHeight: number;
  pageUrl: string;
  pageTitle: string;
}

export interface BrowserStateSnapshot {
  isRunning: boolean;
  currentUrl: string;
  pageReady: boolean;
  navigationLoading: boolean;
  navigationError?: string;
  pageTitle: string;
  viewport: { width: number; height: number };
  storageStatePath: string;
  availableStorageStates: StorageStateCandidate[];
  testIdAttribute: string;
  projectRoot: string;
  lastHighlight?: HighlightLocatorResult;
}

export interface ProbeLocatorCountResult {
  browserReady: boolean;
  pageUrl: string;
  count: number;
  visibleCount: number;
  tagSummary: string;
}

/**
 * Управляет экземпляром Chromium из Playwright проекта, сессией CDP Screencast
 * и живой подсветкой локаторов в DOM страницы.
 */
export class BrowserManager extends EventEmitter {
  private runtime?: WorkspacePlaywrightRuntime;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private browser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private context: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cdpSession: any;

  private viewport = { width: 1440, height: 900 };
  private storageStatePath = '';
  private readEnvFiles = false;
  private currentUrl = 'about:blank';
  private pageReady = false;
  private pendingNavigationRequest?: object;
  private navigationError?: string;
  private explicitNavigation?: object;
  private closing?: Promise<void>;

  public isPageReady(): boolean {
    return this.pageReady && Boolean(this.page && !this.page.isClosed());
  }

  private publishVisit(...urls: string[]): void {
    if (this.runtime) {
      this.emit('navigationVisited', this.runtime.projectRoot, urls);
    }
  }
  private pageTitle = '';
  private isScreencastActive = false;
  private frameInFlight = false;
  private lastHighlight?: HighlightLocatorResult;
  private lastDescriptor?: LocatorDescriptor;
  private lastMeta?: {
    expressionText?: string;
    strippedActionMethod?: string;
    parameterInfo?: HighlightParameterInfo;
  };
  private searchEpoch = 0;
  private documentEpoch = 0;
  private nuxtStartupScroll?: {
    page: unknown;
    documentEpoch: number;
    settled: boolean;
    done: Promise<void>;
  };
  private domChangeTimer?: ReturnType<typeof setTimeout>;
  private navigationRehighlightTimer?: ReturnType<typeof setTimeout>;
  private navigationRetryTimer?: ReturnType<typeof setTimeout>;

  private cancelScheduledRehighlight(): void {
    if (this.navigationRehighlightTimer) {
      clearTimeout(this.navigationRehighlightTimer);
      this.navigationRehighlightTimer = undefined;
    }
    if (this.navigationRetryTimer) {
      clearTimeout(this.navigationRetryTimer);
      this.navigationRetryTimer = undefined;
    }
  }

  private scheduleRehighlightAfterNavigation(delayMs: number): void {
    this.cancelScheduledRehighlight();
    if (!this.lastDescriptor || !this.page || this.page.isClosed?.()) {
      return;
    }
    const scheduledEpoch = this.searchEpoch;
    const targetDescriptor = this.lastDescriptor;
    const targetMeta = this.lastMeta;

    this.navigationRehighlightTimer = setTimeout(async () => {
      this.navigationRehighlightTimer = undefined;
      if (
        scheduledEpoch !== this.searchEpoch ||
        this.lastDescriptor !== targetDescriptor ||
        !this.page ||
        this.page.isClosed?.()
      ) {
        return;
      }
      try {
        const res = await this.highlightLocator(targetDescriptor, targetMeta);
        if (
          res.count === 0 &&
          this.lastDescriptor === targetDescriptor &&
          this.page &&
          !this.page.isClosed?.()
        ) {
          const retryEpoch = this.searchEpoch;
          this.navigationRetryTimer = setTimeout(async () => {
            this.navigationRetryTimer = undefined;
            if (
              retryEpoch !== this.searchEpoch ||
              this.lastDescriptor !== targetDescriptor ||
              !this.page ||
              this.page.isClosed?.()
            ) {
              return;
            }
            try {
              const probe = await this.probeLocatorCount(targetDescriptor);
              if (
                retryEpoch === this.searchEpoch &&
                this.lastDescriptor === targetDescriptor &&
                probe.browserReady &&
                probe.count > 0
              ) {
                await this.highlightLocator(targetDescriptor, targetMeta);
              }
            } catch {
              // ignore
            }
          }, 750);
        }
      } catch {
        // ignore
      }
    }, delayMs);
  }

  public async ensureStarted(options?: {
    activeFilePath?: string;
    workspaceRoot?: string;
    initialUrl?: string;
    storageStatePath?: string;
    viewport?: { width: number; height: number };
    readEnvFiles?: boolean;
  }): Promise<BrowserStateSnapshot> {
    await this.closing;
    const requestedReadEnv =
      options?.readEnvFiles !== undefined
        ? Boolean(options.readEnvFiles)
        : this.readEnvFiles;

    if (
      !this.runtime ||
      options?.activeFilePath ||
      options?.workspaceRoot ||
      requestedReadEnv !== this.readEnvFiles
    ) {
      const nextRuntime = resolveWorkspacePlaywright(
        options?.activeFilePath,
        options?.workspaceRoot,
        { readEnvFiles: requestedReadEnv }
      );
      if (
        !this.runtime ||
        this.runtime.projectRoot !== nextRuntime.projectRoot ||
        requestedReadEnv !== this.readEnvFiles
      ) {
        if (this.runtime && this.runtime.projectRoot !== nextRuntime.projectRoot) {
          await this.dispose();
          this.storageStatePath = '';
        }
        this.runtime = nextRuntime;
        this.readEnvFiles = requestedReadEnv;
        this.viewport = options?.viewport || { ...nextRuntime.config.viewport };
        if (options?.storageStatePath !== undefined) {
          this.storageStatePath = options.storageStatePath;
        } else if (
          !this.storageStatePath &&
          nextRuntime.config.defaultStorageStatePath
        ) {
          this.storageStatePath = nextRuntime.config.defaultStorageStatePath;
        }
      }
    }

    if (!this.runtime) {
      throw new Error('Playwright environment is not initialized.');
    }

    // Всегда синхронизируем testIdAttribute перед работой с локаторами
    if (this.runtime.config.testIdAttribute) {
      this.runtime.selectors.setTestIdAttribute(this.runtime.config.testIdAttribute);
    }

    if (!this.browser || !this.browser.isConnected?.()) {
      this.browser = await this.runtime.chromium.launch({
        headless: true,
        args: this.runtime.config.launchArgs,
      });
      this.browser.on?.('disconnected', () => {
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        this.cdpSession = undefined;
        this.isScreencastActive = false;
        this.emit('stateChanged', this.getStateSnapshot());
      });
    }

    if (!this.context || !this.page || this.page.isClosed?.()) {
      await this.recreateContextAndPage(options?.initialUrl);
    } else if (options?.initialUrl && this.currentUrl === 'about:blank') {
      await this.navigate(options.initialUrl);
    }

    const state = this.getStateSnapshot();
    if (state.isRunning) {
      this.emit('browserReady');
    }
    return state;
  }

  private async recreateContextAndPage(targetUrl?: string): Promise<void> {
    if (!this.runtime || !this.browser) {
      return;
    }

    await this.stopScreencast();
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // ignore
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contextOptions: Record<string, any> = {
      ignoreHTTPSErrors: this.runtime.config.ignoreHTTPSErrors,
      viewport: {
        width: this.viewport.width,
        height: this.viewport.height,
      },
    };

    if (this.storageStatePath) {
      const check = isValidPlaywrightStorageStateFile(this.storageStatePath);
      if (check.valid) {
        contextOptions.storageState = this.storageStatePath;
      } else {
        this.storageStatePath = '';
      }
    }

    this.context = await this.browser.newContext(contextOptions);

    // Безопасные extraHTTPHeaders подставляем строго на same-origin целевого baseURL,
    // чтобы заголовки никогда не утекали на сторонние домены и CDN.
    if (
      this.runtime.config.extraHTTPHeaders &&
      Object.keys(this.runtime.config.extraHTTPHeaders).length > 0 &&
      this.runtime.config.baseURL
    ) {
      try {
        const allowedOrigin = new URL(this.runtime.config.baseURL).origin;
        const extraHeaders = { ...this.runtime.config.extraHTTPHeaders };
        await this.context.route(
          (url: URL) => {
            try {
              return new URL(String(url)).origin === allowedOrigin;
            } catch {
              return false;
            }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (route: any) => {
            try {
              const mergedHeaders = {
                ...route.request().headers(),
                ...extraHeaders,
              };
              await route.continue({ headers: mergedHeaders });
            } catch {
              await route.continue().catch(() => undefined);
            }
          }
        );
      } catch {
        // Если baseURL некорректен — не подставляем extraHTTPHeaders
      }
    }

    await this.context.exposeBinding('__pwLocatorInspectorDomChanged', ({ page }: { page: unknown }) => {
      if (page === this.page && this.isPageReady() && !this.domChangeTimer) {
        this.domChangeTimer = setTimeout(() => {
          this.domChangeTimer = undefined;
          if (page === this.page && this.isPageReady()) this.emit('domChanged');
        }, 220);
      }
    });
    await this.context.addInitScript(() => {
      const notify = (globalThis as unknown as { __pwLocatorInspectorDomChanged: () => Promise<void> }).__pwLocatorInspectorDomChanged;
      const isOverlay = (node: Node): boolean => {
        const element = node instanceof Element ? node : node.parentElement;
        return Boolean(element?.closest('#__pw_locator_inspector_overlay__, x-pw-glass'));
      };
      let pending = false;
      new MutationObserver((records) => {
        if (pending || !records.some((record) => {
          if (isOverlay(record.target)) return false;
          return record.type !== 'childList' ||
            [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) => !isOverlay(node));
        })) return;
        pending = true;
        setTimeout(() => {
          pending = false;
          void notify().catch(() => undefined);
        }, 120);
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    this.page = await this.context.newPage();
    this.pageReady = false;
    const page = this.page;
    let navigationStatus: number | undefined;
    type NavigationRequest = { isNavigationRequest(): boolean; frame(): unknown };
    const isMainNavigation = (request: NavigationRequest): boolean => {
      try {
        return page === this.page && request.isNavigationRequest() && request.frame() === page.mainFrame();
      } catch {
        return false;
      }
    };
    page.on('request', (request: NavigationRequest) => {
      if (isMainNavigation(request)) {
        this.documentEpoch += 1;
        this.nuxtStartupScroll = undefined;
        this.pendingNavigationRequest = request;
        navigationStatus = undefined;
        this.pageReady = false;
        this.navigationError = undefined;
        this.emit('pageNavigated', this.currentUrl);
        this.emit('stateChanged', this.getStateSnapshot());
      }
    });
    page.on('response', (response: { request(): NavigationRequest; status(): number }) => {
      if (isMainNavigation(response.request())) {
        navigationStatus = response.status();
      }
    });
    page.on('requestfailed', (request: NavigationRequest) => {
      if (page !== this.page || request !== this.pendingNavigationRequest) return;
      this.pendingNavigationRequest = undefined;
      if (!this.explicitNavigation) {
        this.navigationError = 'Could not open the page.';
        this.emit('stateChanged', this.getStateSnapshot());
      }
    });

    this.page.on('framenavigated', async (frame: { parentFrame: () => unknown; url: () => string }) => {
      if (!frame.parentFrame()) {
        const nextUrl = frame.url();
        const urlChanged = nextUrl !== this.currentUrl;
        this.currentUrl = nextUrl;
        if (urlChanged && this.isPageReady() && !this.explicitNavigation) {
          this.publishVisit(nextUrl);
        }
        try {
          this.pageTitle = await this.page.title();
        } catch {
          // ignore
        }
        if (urlChanged) {
          this.lastHighlight = undefined;
          await this.clearHighlight();
          if (this.lastDescriptor) {
            this.scheduleRehighlightAfterNavigation(250);
          }
          this.emit('pageNavigated', this.currentUrl);
        }
        this.emit('stateChanged', this.getStateSnapshot());
      }
    });

    page.on('domcontentloaded', async () => {
      if (page !== this.page) return;
      this.pendingNavigationRequest = undefined;
      if (this.explicitNavigation) return;
      this.currentUrl = page.url();
      this.pageReady = /^https?:\/\//i.test(this.currentUrl) && (navigationStatus === undefined || navigationStatus < 400);
      this.navigationError = navigationStatus !== undefined && navigationStatus >= 400
        ? `Could not open the page (HTTP ${navigationStatus}).`
        : undefined;
      if (this.pageReady) {
        this.publishVisit(this.currentUrl);
      }
      this.emit('pageNavigated', this.currentUrl);
      this.emit('stateChanged', this.getStateSnapshot());
    });

    page.on('load', async () => {
      if (page !== this.page) {
        return;
      }
      try {
        this.currentUrl = page.url();
        this.pageTitle = await this.page.title();
      } catch {
        // ignore
      }
      if (this.lastDescriptor) {
        this.scheduleRehighlightAfterNavigation(150);
      }
      this.emit('pageNavigated', this.currentUrl);
      this.emit('stateChanged', this.getStateSnapshot());
    });

    await this.startScreencast();

    const urlToOpen = targetUrl;

    if (urlToOpen && urlToOpen !== 'about:blank') {
      await this.navigate(urlToOpen);
    }
  }

  /**
   * Запускает CDP Screencast с обязательным подтверждением каждого кадра через Page.screencastFrameAck.
   */
  public async startScreencast(): Promise<void> {
    if (!this.context || !this.page || this.isScreencastActive) {
      return;
    }

    try {
      this.cdpSession = await this.context.newCDPSession(this.page);
      this.isScreencastActive = true;

      this.cdpSession.on(
        'Page.screencastFrame',
        async (event: {
          data: string;
          sessionId: number;
          metadata?: { deviceWidth?: number; deviceHeight?: number };
        }) => {
          const { data, sessionId, metadata } = event;
          // Обязательный Page.screencastFrameAck на каждый кадр, чтобы Chromium не остановил поток
          if (this.cdpSession) {
            try {
              await this.cdpSession.send('Page.screencastFrameAck', { sessionId });
            } catch {
              // Сессия могла закрыться во время навигации/пересоздания контекста
              return;
            }
          }

          if (this.frameInFlight) {
            return;
          }
          this.frameInFlight = true;
          try {
            const liveUrl = this.page ? this.page.url() : this.currentUrl;
            // Если произошёл клиентский SPA-переход (pushState/replaceState), сбрасываем старую подсветку
            // и автоматически перезапускаем поиск активного локатора на новой странице
            if (liveUrl && liveUrl !== this.currentUrl) {
              this.currentUrl = liveUrl;
              if (this.isPageReady() && !this.explicitNavigation) this.publishVisit(liveUrl);
              if (this.lastHighlight) {
                this.lastHighlight = undefined;
                await this.clearHighlight();
              }
              if (this.lastDescriptor) {
                this.scheduleRehighlightAfterNavigation(350);
              }
              this.emit('pageNavigated', this.currentUrl);
              this.emit('stateChanged', this.getStateSnapshot());
            }
            const payload: ScreencastFramePayload = {
              data,
              deviceWidth: metadata?.deviceWidth || this.viewport.width,
              deviceHeight: metadata?.deviceHeight || this.viewport.height,
              pageUrl: liveUrl,
              pageTitle: this.pageTitle,
            };
            this.emit('screencastFrame', payload);
          } finally {
            this.frameInFlight = false;
          }
        }
      );

      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 82,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1,
      });
    } catch {
      this.isScreencastActive = false;
    }
  }

  public async stopScreencast(): Promise<void> {
    this.isScreencastActive = false;
    if (!this.cdpSession) {
      return;
    }
    const session = this.cdpSession;
    this.cdpSession = undefined;
    try {
      await session.send('Page.stopScreencast');
    } catch {
      // ignore
    }
    try {
      await session.detach();
    } catch {
      // ignore
    }
  }

  public async navigate(rawUrl: string): Promise<void> {
    if (!this.page) {
      return;
    }
    let targetUrl = rawUrl.trim();
    if (!targetUrl) {
      return;
    }
    if (
      targetUrl.startsWith('/') &&
      this.runtime?.config.baseURL
    ) {
      targetUrl = new URL(targetUrl, this.runtime.config.baseURL).toString();
    } else if (!/^https?:\/\//i.test(targetUrl) && targetUrl !== 'about:blank') {
      targetUrl = `https://${targetUrl}`;
    }

    const page = this.page;
    const navigation = {};
    this.explicitNavigation = navigation;
    this.navigationError = undefined;
    this.pageReady = false;
    this.lastHighlight = undefined;
    this.emit('pageNavigated', this.currentUrl);
    this.emit('stateChanged', this.getStateSnapshot());
    try {
      await this.clearHighlight();
      const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (this.explicitNavigation !== navigation || page !== this.page) return;
      this.currentUrl = page.url();
      if (response && response.status() >= 400) {
        this.navigationError = `Could not open the page (HTTP ${response.status()}).`;
      } else if (/^https?:\/\//i.test(this.currentUrl)) {
        this.pageReady = true;
        this.publishVisit(targetUrl, this.currentUrl);
      }
    } catch {
      if (this.explicitNavigation !== navigation || page !== this.page) return;
      this.navigationError = 'Could not open the page. Check the URL and try again.';
    } finally {
      if (this.explicitNavigation === navigation) {
        this.explicitNavigation = undefined;
        this.pendingNavigationRequest = undefined;
      }
    }
    if (page !== this.page) return;
    try {
      this.pageTitle = await this.page.title();
    } catch {
      // ignore
    }
    if (this.lastDescriptor) {
      this.scheduleRehighlightAfterNavigation(150);
    }
    this.emit('pageNavigated', this.currentUrl);
    this.emit('stateChanged', this.getStateSnapshot());
  }

  public async goBack(): Promise<void> {
    if (!this.page) {
      return;
    }
    this.lastHighlight = undefined;
    await this.clearHighlight();
    await this.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    this.currentUrl = this.page.url();
    if (this.lastDescriptor) {
      this.scheduleRehighlightAfterNavigation(150);
    }
    this.emit('pageNavigated', this.currentUrl);
    this.emit('stateChanged', this.getStateSnapshot());
  }

  public async goForward(): Promise<void> {
    if (!this.page) {
      return;
    }
    this.lastHighlight = undefined;
    await this.clearHighlight();
    await this.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    this.currentUrl = this.page.url();
    if (this.lastDescriptor) {
      this.scheduleRehighlightAfterNavigation(150);
    }
    this.emit('pageNavigated', this.currentUrl);
    this.emit('stateChanged', this.getStateSnapshot());
  }

  public async reload(): Promise<void> {
    if (!this.page) {
      return;
    }
    this.lastHighlight = undefined;
    await this.clearHighlight();
    await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    this.currentUrl = this.page.url();
    if (this.lastDescriptor) {
      this.scheduleRehighlightAfterNavigation(150);
    }
    this.emit('pageNavigated', this.currentUrl);
    this.emit('stateChanged', this.getStateSnapshot());
  }

  public async setStorageState(storageStatePath: string): Promise<BrowserStateSnapshot> {
    if (storageStatePath) {
      const check = isValidPlaywrightStorageStateFile(storageStatePath);
      if (!check.valid) {
        throw new Error(
          `File "${storageStatePath}" is not a valid Playwright storageState (expected a JSON object with cookies and/or origins arrays).`
        );
      }
    }
    this.storageStatePath = storageStatePath;
    await this.recreateContextAndPage(this.currentUrl);
    this.emit('pageNavigated', this.currentUrl);
    this.emit('stateChanged', this.getStateSnapshot());
    return this.getStateSnapshot();
  }

  public async setViewportSize(width: number, height: number): Promise<void> {
    this.viewport = { width, height };
    if (!this.page) {
      return;
    }
    await this.page.setViewportSize({ width, height });
    await this.stopScreencast();
    await this.startScreencast();
    this.scheduleRehighlightAfterNavigation(150);
    this.emit('viewportChanged');
    this.emit('stateChanged', this.getStateSnapshot());
  }

  /**
   * Пробрасывает события мыши из Webview в страницу Playwright (координаты уже смапплены к viewport).
   */
  public async handleMouseEvent(event: {
    type: 'mousedown' | 'mouseup' | 'mousemove' | 'click' | 'dblclick' | 'wheel';
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
    deltaX?: number;
    deltaY?: number;
  }): Promise<void> {
    if (!this.page) {
      return;
    }
    const x = Math.max(0, Math.min(this.viewport.width, Math.round(event.x)));
    const y = Math.max(0, Math.min(this.viewport.height, Math.round(event.y)));
    const button = event.button || 'left';

    try {
      switch (event.type) {
        case 'mousemove':
          await this.page.mouse.move(x, y);
          break;
        case 'mousedown':
          await this.page.mouse.move(x, y);
          await this.page.mouse.down({ button });
          break;
        case 'mouseup':
          await this.page.mouse.move(x, y);
          await this.page.mouse.up({ button });
          break;
        case 'click':
          await this.page.mouse.click(x, y, { button });
          break;
        case 'dblclick':
          await this.page.mouse.dblclick(x, y, { button });
          break;
        case 'wheel':
          await this.page.mouse.move(x, y);
          await this.page.mouse.wheel(event.deltaX || 0, event.deltaY || 0);
          break;
      }
    } catch {
      // Игнорируем транзиентные ошибки ввода во время навигации
    }
  }

  /**
   * Пробрасывает нажатия клавиш и ввод текста из Webview в активный элемент страницы.
   */
  public async handleKeyEvent(event: {
    type: 'press' | 'insertText';
    key?: string;
    text?: string;
  }): Promise<void> {
    if (!this.page) {
      return;
    }
    try {
      if (event.type === 'insertText' && event.text) {
        await this.page.keyboard.insertText(event.text);
      } else if (event.type === 'press' && event.key) {
        await this.page.keyboard.press(event.key);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Снимает активную подсветку локаторов на странице (включая нативный <x-pw-glass> от Playwright).
   */
  public async clearHighlight(resetState: boolean = false): Promise<void> {
    if (resetState) {
      this.searchEpoch += 1;
      this.cancelScheduledRehighlight();
      this.lastHighlight = undefined;
      this.lastDescriptor = undefined;
      this.lastMeta = undefined;
    }
    if (this.page) {
      try {
        await this.page.evaluate(() => {
          const doc = (globalThis as unknown as { document?: any }).document;
          if (!doc) {
            return;
          }
          const win = globalThis as unknown as {
            __pwLocatorInspectorCleanup?: () => void;
          };
          if (typeof win.__pwLocatorInspectorCleanup === 'function') {
            win.__pwLocatorInspectorCleanup();
            win.__pwLocatorInspectorCleanup = undefined;
          }
          const overlays = doc.querySelectorAll(
            '#__pw_locator_inspector_overlay__, x-pw-inspector-overlay, x-pw-glass'
          );
          for (const el of overlays) {
            el.remove();
          }
        });
      } catch {
        // ignore
      }
    }
    if (resetState) {
      this.emit('stateChanged', this.getStateSnapshot());
    }
  }

  /**
   * Тихая проверка количества совпадений локатора с DOM открытой страницы
   * без изменения активной подсветки, без скролла и без генерации событий.
   */
  public async probeLocatorCount(
    descriptor: LocatorDescriptor
  ): Promise<ProbeLocatorCountResult> {
    if (
      !this.isPageReady() ||
      !this.runtime ||
      !this.browser ||
      !this.browser.isConnected?.() ||
      this.page.isClosed?.()
    ) {
      return {
        browserReady: false,
        pageUrl: this.currentUrl,
        count: 0,
        visibleCount: 0,
        tagSummary: '',
      };
    }

    if (this.runtime.config.testIdAttribute) {
      this.runtime.selectors.setTestIdAttribute(
        this.runtime.config.testIdAttribute
      );
    }

    const pageUrl = this.page.url?.() || this.currentUrl;
    const locator = materializeLocator(this.page, descriptor);
    const count: number = await locator.count();

    if (count === 0) {
      return {
        browserReady: true,
        pageUrl,
        count: 0,
        visibleCount: 0,
        tagSummary: '',
      };
    }

    const testIdAttrs = (this.runtime.config.testIdAttribute || 'data-testid')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const summary = await locator.evaluateAll((nodes: unknown[], attrs: string[]) => {
      const win = globalThis as unknown as Record<string, any>;
      let visibleCount = 0;
      let tagSummary = '';

      nodes.forEach((rawNode, index) => {
        const el = rawNode as any;
        const rect = el.getBoundingClientRect?.() || {
          width: 0,
          height: 0,
        };
        const style = win.getComputedStyle ? win.getComputedStyle(el) : null;
        const isVisible = Boolean(
          rect.width > 0 &&
            rect.height > 0 &&
            (!style ||
              (style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                style.opacity !== '0'))
        );
        if (isVisible) {
          visibleCount += 1;
        }
        if (index === 0) {
          const tag = String(el.tagName || '').toLowerCase();
          let matchedAttrName = '';
          let matchedAttrVal = '';
          for (const attr of attrs) {
            const val = el.getAttribute?.(attr);
            if (val) {
              matchedAttrName = attr;
              matchedAttrVal = String(val);
              break;
            }
          }
          const role = String(el.getAttribute?.('role') || '');
          tagSummary = `<${tag}${matchedAttrVal ? ` ${matchedAttrName}="${matchedAttrVal}"` : ''}${role ? ` role="${role}"` : ''}>`;
        }
      });

      return { visibleCount, tagSummary };
    }, testIdAttrs);

    return {
      browserReady: true,
      pageUrl,
      count,
      visibleCount: summary.visibleCount,
      tagSummary: summary.tagSummary,
    };
  }

  /**
   * Выделяет и скроллит к конкретному найденному элементу по его 0-based индексу
   * (или возвращает показ всех элементов при elementIndex === null).
   */
  public async focusHighlightedElement(
    elementIndex: number | null
  ): Promise<HighlightLocatorResult | undefined> {
    if (!this.lastDescriptor) {
      return undefined;
    }
    return this.highlightLocator(
      this.lastDescriptor,
      this.lastMeta,
      elementIndex
    );
  }

  private async getNuxtStartupScroll(page: any, documentEpoch: number) {
    if (this.nuxtStartupScroll?.page === page && this.nuxtStartupScroll?.documentEpoch === documentEpoch) {
      return this.nuxtStartupScroll.settled ? undefined : this.nuxtStartupScroll;
    }
    const isNuxt = await page.evaluate(() => Boolean(
      document.querySelector('#__nuxt, script[data-nuxt-data]')
    )).catch(() => false);
    if (!isNuxt || page !== this.page || documentEpoch !== this.documentEpoch) return undefined;
    // Another highlight may have started the wait while we detected Nuxt.
    if (this.nuxtStartupScroll?.page === page && this.nuxtStartupScroll?.documentEpoch === documentEpoch) {
      return this.nuxtStartupScroll.settled ? undefined : this.nuxtStartupScroll;
    }

    const done: Promise<void> = page.evaluate(() => new Promise<void>((resolve) => {
      const started = performance.now();
      let stableSince: number | undefined;
      let x = window.scrollX;
      let y = window.scrollY;
      const check = () => {
        const now = performance.now();
        type VueRoot = Element & {
          __vue_app__?: { config?: { globalProperties?: { $nuxt?: { isHydrating?: boolean } } } };
        };
        // Nuxt can mount to a custom root instead of #__nuxt.
        const roots = [document.getElementById('__nuxt'), ...Array.from(document.body?.children || [])];
        const hydrating = roots.some((root) => (root as VueRoot | null)
          ?.__vue_app__?.config?.globalProperties?.$nuxt?.isHydrating === true);
        const ready = document.readyState === 'complete' && !hydrating;
        if (!ready || x !== window.scrollX || y !== window.scrollY) {
          stableSince = undefined;
        } else {
          stableSince ??= now;
        }
        x = window.scrollX;
        y = window.scrollY;
        // Don't let stalled resources or an unmounted Nuxt app disable autoscroll forever.
        if ((stableSince !== undefined && now - stableSince >= 120) || now - started >= 7000) {
          resolve();
        } else {
          setTimeout(check, 32);
        }
      };
      check();
    }));
    const startup = { page, documentEpoch, settled: false, done };
    this.nuxtStartupScroll = startup;
    void done.then(() => { startup.settled = true; }, () => {
      if (this.nuxtStartupScroll === startup) this.nuxtStartupScroll = undefined;
    });
    return startup;
  }

  /**
   * Материализует LocatorDescriptor на открытой странице, проверяет count(),
   * скроллит страницу к первому (или выбранному) элементу и рисует живую подсветку с автообновлением при скролле.
   */
  public async highlightLocator(
    descriptor: LocatorDescriptor,
    meta?: {
      expressionText?: string;
      strippedActionMethod?: string;
      parameterInfo?: HighlightParameterInfo;
    },
    targetElementIndex: number | null = null
  ): Promise<HighlightLocatorResult> {
    if (!this.page || !this.runtime) {
      throw new Error('Inspector browser is not running yet.');
    }

    if (this.runtime.config.testIdAttribute) {
      this.runtime.selectors.setTestIdAttribute(this.runtime.config.testIdAttribute);
    }

    const epoch = ++this.searchEpoch;
    const page = this.page;
    const isCurrent = () => epoch === this.searchEpoch && page === this.page;
    const cancelled: HighlightLocatorResult = {
      count: 0, visibleCount: 0, elements: [], statusText: 'Search cancelled',
      expressionText: '', humanReadable: '',
    };
    this.cancelScheduledRehighlight();
    this.lastDescriptor = descriptor;
    this.lastMeta = meta;

    await this.clearHighlight();
    if (!isCurrent()) return cancelled;

    const waitingForPage = !this.isPageReady();
    const locator = waitingForPage ? undefined : materializeLocator(page, descriptor);
    const count: number = locator ? await locator.count() : 0;
    if (!isCurrent()) return cancelled;

    if (count === 0) {
      const emptyResult: HighlightLocatorResult = {
        count: 0,
        visibleCount: 0,
        elements: [],
        statusText: waitingForPage ? 'Waiting for page' : 'Found: 0 (not in DOM)',
        waitingForPage,
        expressionText: meta?.expressionText || descriptor.humanReadable,
        humanReadable: descriptor.humanReadable,
        strippedActionMethod: meta?.strippedActionMethod,
        activeElementIndex: null,
        parameterInfo: meta?.parameterInfo,
      };
      this.lastHighlight = emptyResult;
      this.emit('highlightChanged', emptyResult);
      this.emit('stateChanged', this.getStateSnapshot());
      return emptyResult;
    }

    const resolvedFocusIndex =
      typeof targetElementIndex === 'number' &&
      targetElementIndex >= 0 &&
      targetElementIndex < count
        ? targetElementIndex
        : null;

    const scrollTarget = resolvedFocusIndex !== null ? locator.nth(resolvedFocusIndex) : locator.first();
    const documentEpoch = this.documentEpoch;
    const pageUrl = page.url();
    const canScroll = () => isCurrent() && this.isPageReady() &&
      this.documentEpoch === documentEpoch && page.url() === pageUrl;
    const startup = await this.getNuxtStartupScroll(page, documentEpoch);
    if (!canScroll()) return cancelled;

    // Center the target to keep it clear of fixed/sticky page headers.
    const scrollToTarget = async () => {
      if (!canScroll()) return;
      try {
        await scrollTarget.evaluate((el: Element) => {
          el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
          const win = el.ownerDocument.defaultView;
          const rect = el.getBoundingClientRect();
          if (win && rect.top < 80 && rect.bottom < win.innerHeight - 80) {
            win.scrollBy({ top: rect.top - 80, behavior: 'instant' });
          }
        }, undefined, { timeout: 500 });
      } catch {
        // The target may have disappeared during navigation or hydration.
      }
    };
    if (!startup) await scrollToTarget();

    // Один оверлей: нативная подсветка добавляет вторую рамку и подпись.
    if (!isCurrent()) return cancelled;

    const testIdAttrs = (this.runtime.config.testIdAttribute || 'data-testid')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const elements: HighlightedElementInfo[] = await locator.evaluateAll(
      (
        nodes: unknown[],
        overlayArgs: { focusIndex: number | null; testIdAttrs: string[] }
      ) => {
        const { focusIndex, testIdAttrs: attrs } = overlayArgs;
        const win = globalThis as unknown as Record<string, any>;
        const doc = win.document;

        const getElTestId = (el: any): string => {
          for (const attr of attrs) {
            const val = el.getAttribute?.(attr);
            if (val) {
              return String(val);
            }
          }
          return '';
        };

        if (typeof win.__pwLocatorInspectorCleanup === 'function') {
          win.__pwLocatorInspectorCleanup();
          win.__pwLocatorInspectorCleanup = undefined;
        }
        const oldOverlay = doc.getElementById('__pw_locator_inspector_overlay__');
        if (oldOverlay) {
          oldOverlay.remove();
        }

        const overlayRoot = doc.createElement('x-pw-inspector-overlay');
        overlayRoot.id = '__pw_locator_inspector_overlay__';
        overlayRoot.style.cssText = [
          'position: fixed',
          'inset: 0',
          'display: block',
          'pointer-events: none',
          'z-index: 2147483646',
          'overflow: hidden',
        ].join(';');
        doc.documentElement.appendChild(overlayRoot);

        const boxes: Array<{ el: any; boxEl: any; badgeEl: any }> = [];

        nodes.forEach((rawNode, idx) => {
          if (focusIndex !== null && idx !== focusIndex) {
            return;
          }
          const el = rawNode as any;
          const boxEl = doc.createElement('x-pw-inspector-box');
          boxEl.style.cssText = [
            'position: fixed',
            'display: block',
            'border: 2.5px solid #f97316',
            'background: rgba(249, 115, 22, 0.16)',
            'box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.45), 0 0 16px rgba(249, 115, 22, 0.45)',
            'border-radius: 4px',
            'pointer-events: none',
            'transition: top 0.04s linear, left 0.04s linear, width 0.04s linear, height 0.04s linear',
          ].join(';');

          const badgeEl = doc.createElement('x-pw-inspector-badge');
          badgeEl.style.cssText = [
            'position: fixed',
            'display: block',
            'background: #ea580c',
            'color: #ffffff',
            'font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
            'padding: 2px 6px',
            'border-radius: 4px',
            'white-space: nowrap',
            'box-shadow: 0 2px 6px rgba(0,0,0,0.3)',
            'pointer-events: none',
          ].join(';');
          badgeEl.textContent = String(idx + 1);

          overlayRoot.appendChild(boxEl);
          overlayRoot.appendChild(badgeEl);
          boxes.push({ el, boxEl, badgeEl });
        });

        const initialHref = win.location?.href;

        const removeSelfOverlay = () => {
          if (typeof win.__pwLocatorInspectorCleanup === 'function') {
            win.__pwLocatorInspectorCleanup();
            win.__pwLocatorInspectorCleanup = undefined;
          }
          const overlays = doc.querySelectorAll(
            '#__pw_locator_inspector_overlay__, x-pw-inspector-overlay, x-pw-glass'
          );
          for (const el of overlays) {
            el.remove();
          }
        };

        const updatePositions = () => {
          if (initialHref && win.location?.href !== initialHref) {
            removeSelfOverlay();
            return;
          }
          let anyConnected = false;
          for (const item of boxes) {
            if (!item.el.isConnected) {
              item.boxEl.style.display = 'none';
              item.badgeEl.style.display = 'none';
              continue;
            }
            anyConnected = true;
            const rect = item.el.getBoundingClientRect?.();
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              item.boxEl.style.display = 'none';
              item.badgeEl.style.display = 'none';
              continue;
            }
            item.boxEl.style.display = 'block';
            item.badgeEl.style.display = 'block';
            item.boxEl.style.left = `${rect.left}px`;
            item.boxEl.style.top = `${rect.top}px`;
            item.boxEl.style.width = `${Math.max(4, rect.width)}px`;
            item.boxEl.style.height = `${Math.max(4, rect.height)}px`;

            const badgeTop = rect.top >= 24 ? rect.top - 22 : rect.bottom + 4;
            const badgeLeft = Math.max(4, Math.min(win.innerWidth - 180, rect.left));
            item.badgeEl.style.left = `${badgeLeft}px`;
            item.badgeEl.style.top = `${badgeTop}px`;
          }
          if (!anyConnected && boxes.length > 0) {
            removeSelfOverlay();
          }
        };

        updatePositions();
        win.addEventListener('scroll', updatePositions, true);
        win.addEventListener('resize', updatePositions);
        win.addEventListener('popstate', updatePositions);
        const timerId = win.setInterval(updatePositions, 250);

        win.__pwLocatorInspectorCleanup = () => {
          win.removeEventListener('scroll', updatePositions, true);
          win.removeEventListener('resize', updatePositions);
          win.removeEventListener('popstate', updatePositions);
          win.clearInterval(timerId);
        };

        return nodes.map((rawNode, index) => {
          const el = rawNode as any;
          const rect = el.getBoundingClientRect?.() || {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
          };
          const style = win.getComputedStyle ? win.getComputedStyle(el) : null;
          const visible = Boolean(
            rect.width > 0 &&
              rect.height > 0 &&
              (!style ||
                (style.visibility !== 'hidden' &&
                  style.display !== 'none' &&
                  style.opacity !== '0'))
          );
          const rawText = String(el.innerText || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          const rawVal = typeof el.value === 'string' ? el.value : '';

          return {
            index,
            tagName: String(el.tagName || '').toLowerCase(),
            id: String(el.id || ''),
            testId: getElTestId(el),
            role: String(el.getAttribute?.('role') || ''),
            nameAttr: String(el.getAttribute?.('name') || ''),
            typeAttr: String(el.getAttribute?.('type') || ''),
            textPreview: rawText.slice(0, 120),
            imageAlt: String(el.getAttribute?.('alt') || '').slice(0, 120),
            valuePreview: rawVal.slice(0, 80),
            visible,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        });
      },
      {
        focusIndex: resolvedFocusIndex,
        testIdAttrs,
      }
    );

    if (!isCurrent()) return cancelled;
    const visibleCount = elements.filter((e) => e.visible).length;
    const statusText = `Found: ${count} (visible: ${visibleCount})`;
    let humanReadable = descriptor.humanReadable;
    if (resolvedFocusIndex !== null && descriptor.iterations?.length) {
      // DOM-порядок объединения не обязан совпадать с порядком итераций.
      for (const iteration of descriptor.iterations) {
        const branch = materializeLocator(page, iteration);
        if (await scrollTarget.and(branch).count()) {
          humanReadable = iteration.humanReadable;
          break;
        }
        if (!isCurrent()) return cancelled;
      }
    }
    if (!isCurrent()) return cancelled;

    const result: HighlightLocatorResult = {
      count,
      visibleCount,
      elements,
      statusText,
      expressionText: meta?.expressionText || descriptor.humanReadable,
      humanReadable,
      combinedHumanReadable: descriptor.iterations ? descriptor.humanReadable : undefined,
      strippedActionMethod: meta?.strippedActionMethod,
      activeElementIndex: resolvedFocusIndex,
      parameterInfo: meta?.parameterInfo,
    };

    this.lastHighlight = result;
    this.emit('highlightChanged', result);
    this.emit('stateChanged', this.getStateSnapshot());
    if (startup) void startup.done.then(scrollToTarget, () => undefined);
    return result;
  }

  public getPage(): unknown {
    return this.page;
  }

  public getStateSnapshot(): BrowserStateSnapshot {
    const projectRoot = this.runtime?.projectRoot || process.cwd();
    const availableStorageStates = this.runtime
      ? discoverStorageStateFiles(projectRoot)
      : [];

    return {
      isRunning: Boolean(this.browser && this.page && !this.page.isClosed?.()),
      currentUrl: this.currentUrl,
      pageReady: this.isPageReady(),
      navigationLoading: Boolean(this.explicitNavigation || this.pendingNavigationRequest),
      navigationError: this.navigationError,
      pageTitle: this.pageTitle,
      viewport: { ...this.viewport },
      storageStatePath: this.storageStatePath,
      availableStorageStates,
      testIdAttribute: this.runtime?.config.testIdAttribute || 'data-testid',
      projectRoot,
      lastHighlight: this.lastHighlight,
    };
  }

  public dispose(): Promise<void> {
    this.closing ??= this.closeBrowser().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async closeBrowser(): Promise<void> {
    this.pageReady = false;
    this.pendingNavigationRequest = undefined;
    this.currentUrl = 'about:blank';
    this.navigationError = undefined;
    this.explicitNavigation = undefined;
    this.pageTitle = '';
    this.lastHighlight = undefined;
    this.lastDescriptor = undefined;
    this.lastMeta = undefined;
    this.searchEpoch += 1;
    this.cancelScheduledRehighlight();
    await this.stopScreencast();
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // ignore
      }
      this.context = undefined;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.browser = undefined;
    }
    this.page = undefined;
  }
}
