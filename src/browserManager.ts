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
  customValues?: Record<string, unknown>;
  variants: HighlightParameterVariantInfo[];
}

export interface HighlightLocatorResult {
  count: number;
  visibleCount: number;
  elements: HighlightedElementInfo[];
  statusText: string;
  expressionText: string;
  humanReadable: string;
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
  private currentUrl = 'about:blank';
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
  }): Promise<BrowserStateSnapshot> {
    if (!this.runtime || options?.activeFilePath || options?.workspaceRoot) {
      const nextRuntime = resolveWorkspacePlaywright(
        options?.activeFilePath,
        options?.workspaceRoot
      );
      if (!this.runtime || this.runtime.projectRoot !== nextRuntime.projectRoot) {
        this.runtime = nextRuntime;
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

    return this.getStateSnapshot();
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

    if (this.runtime.config.extraHTTPHeaders) {
      contextOptions.extraHTTPHeaders = this.runtime.config.extraHTTPHeaders;
    }

    if (this.storageStatePath) {
      const check = isValidPlaywrightStorageStateFile(this.storageStatePath);
      if (check.valid) {
        contextOptions.storageState = this.storageStatePath;
      } else {
        this.storageStatePath = '';
      }
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    this.page.on('framenavigated', async (frame: { parentFrame: () => unknown; url: () => string }) => {
      if (!frame.parentFrame()) {
        const nextUrl = frame.url();
        const urlChanged = nextUrl !== this.currentUrl;
        this.currentUrl = nextUrl;
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

    this.page.on('load', async () => {
      try {
        this.currentUrl = this.page.url();
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

    const urlToOpen =
      targetUrl ||
      (this.currentUrl !== 'about:blank'
        ? this.currentUrl
        : this.runtime.config.baseURL || '');

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

    this.lastHighlight = undefined;
    await this.clearHighlight();
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    this.currentUrl = this.page.url();
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
      !this.page ||
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

    this.searchEpoch += 1;
    this.cancelScheduledRehighlight();
    this.lastDescriptor = descriptor;
    this.lastMeta = meta;

    // Обязательно очищаем предыдущий оверлей и <x-pw-glass> ДО вычисления нового локатора
    await this.clearHighlight();

    const locator = materializeLocator(this.page, descriptor);
    const count: number = await locator.count();

    if (count === 0) {
      const emptyResult: HighlightLocatorResult = {
        count: 0,
        visibleCount: 0,
        elements: [],
        statusText: 'Found: 0 (not in DOM)',
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

    const targetLocatorForScrollAndGlass =
      resolvedFocusIndex !== null
        ? locator.nth(resolvedFocusIndex)
        : locator.first();

    // Скроллим страницу к центру экрана, чтобы элемент не прятался под fixed/sticky шапкой сайта
    try {
      await targetLocatorForScrollAndGlass.evaluate((el: unknown) => {
        const domEl = el as {
          scrollIntoView?: (opts: Record<string, string>) => void;
          getBoundingClientRect?: () => { top: number; bottom: number };
        };
        const win = globalThis as unknown as {
          scrollBy?: (x: number, y: number) => void;
          innerHeight?: number;
        };
        if (typeof domEl.scrollIntoView === 'function') {
          domEl.scrollIntoView({
            behavior: 'instant',
            block: 'center',
            inline: 'nearest',
          });
          if (typeof win.scrollBy === 'function' && typeof domEl.getBoundingClientRect === 'function') {
            const rect = domEl.getBoundingClientRect();
            const vh = win.innerHeight || 900;
            if (rect.top < 80 && rect.bottom < vh - 80) {
              win.scrollBy(0, rect.top - 80);
            }
          }
        }
      });
    } catch {
      // ignore
    }

    // Вызываем нативный highlight() Playwright (для конкретного элемента или всей выборки)
    if (resolvedFocusIndex !== null) {
      await locator.nth(resolvedFocusIndex).highlight().catch(() => undefined);
    } else {
      await locator.highlight().catch(() => undefined);
    }

    const testIdAttrs = (this.runtime.config.testIdAttribute || 'data-testid')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const elements: HighlightedElementInfo[] = await locator.evaluateAll(
      (
        nodes: unknown[],
        overlayArgs: { exprLabel: string; focusIndex: number | null; testIdAttrs: string[] }
      ) => {
        const { exprLabel, focusIndex, testIdAttrs: attrs } = overlayArgs;
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

        const banner = doc.createElement('x-pw-inspector-banner');
        banner.style.cssText = [
          'position: fixed',
          'top: 12px',
          'right: 12px',
          'display: block',
          'background: rgba(15, 23, 42, 0.92)',
          'color: #f8fafc',
          'border: 1.5px solid #38bdf8',
          'border-radius: 8px',
          'padding: 8px 12px',
          'font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35)',
          'max-width: 520px',
          'word-break: break-all',
          'pointer-events: none',
        ].join(';');
        banner.textContent =
          focusIndex !== null
            ? `Element #${focusIndex + 1} of ${nodes.length} • ${exprLabel}`
            : `Found: ${nodes.length} • ${exprLabel}`;
        overlayRoot.appendChild(banner);

        const boxes: Array<{ el: any; boxEl: any; badgeEl: any; idx: number }> = [];

        const describeElement = (el: any, idx: number) => {
          const tag = String(el.tagName || '').toLowerCase();
          const testId = getElTestId(el);
          const role = el.getAttribute?.('role') || '';
          const id = el.id ? `#${el.id}` : '';
          const testIdPart = testId ? `[testId="${testId}"]` : '';
          const rolePart = role ? `[role="${role}"]` : '';
          return `#${idx + 1} <${tag}>${id}${testIdPart}${rolePart}`;
        };

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
          badgeEl.textContent = describeElement(el, idx);

          overlayRoot.appendChild(boxEl);
          overlayRoot.appendChild(badgeEl);
          boxes.push({ el, boxEl, badgeEl, idx });
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
        exprLabel: meta?.expressionText || descriptor.humanReadable,
        focusIndex: resolvedFocusIndex,
        testIdAttrs,
      }
    );

    const visibleCount = elements.filter((e) => e.visible).length;
    const strippedNote = meta?.strippedActionMethod
      ? ` [action .${meta.strippedActionMethod}() stripped]`
      : '';

    const statusText = `Found: ${count} (visible: ${visibleCount})${strippedNote}`;

    const result: HighlightLocatorResult = {
      count,
      visibleCount,
      elements,
      statusText,
      expressionText: meta?.expressionText || descriptor.humanReadable,
      humanReadable: descriptor.humanReadable,
      strippedActionMethod: meta?.strippedActionMethod,
      activeElementIndex: resolvedFocusIndex,
      parameterInfo: meta?.parameterInfo,
    };

    this.lastHighlight = result;
    this.emit('highlightChanged', result);
    this.emit('stateChanged', this.getStateSnapshot());
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
      pageTitle: this.pageTitle,
      viewport: { ...this.viewport },
      storageStatePath: this.storageStatePath,
      availableStorageStates,
      testIdAttribute: this.runtime?.config.testIdAttribute || 'data-testid',
      projectRoot,
      lastHighlight: this.lastHighlight,
    };
  }

  public async dispose(): Promise<void> {
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
