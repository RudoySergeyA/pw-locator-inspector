import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BrowserManager, HighlightParameterInfo } from './browserManager';
import {
  collectFileLocators,
  LocatorDescriptor,
  ResolvedLocatorResult,
  resolveLocatorAtPosition,
  resolveLocatorFromSnippet,
  SerializedArg,
  StaticForResolutionError,
} from './locatorAstResolver';
import { BrowserWebviewPanel } from './webviewPanel';

let browserManager: BrowserManager | undefined;

interface EditorContextSnapshot {
  filePath: string;
  sourceText: string;
  cursorLine: number;
}

const CODE_FILE_EXT_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

export function activate(context: vscode.ExtensionContext): void {
  browserManager = new BrowserManager();

  let lastEditorContext: EditorContextSnapshot | undefined;

  const isCodeDocument = (doc?: vscode.TextDocument): doc is vscode.TextDocument => {
    if (!doc || doc.uri.scheme !== 'file') {
      return false;
    }
    return CODE_FILE_EXT_REGEX.test(doc.uri.fsPath);
  };

  const captureEditorContext = (editor?: vscode.TextEditor) => {
    if (!editor || !isCodeDocument(editor.document)) {
      return;
    }
    lastEditorContext = {
      filePath: editor.document.uri.fsPath,
      sourceText: editor.document.getText(),
      cursorLine: editor.selection.active.line + 1,
    };
  };

  captureEditorContext(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      captureEditorContext(ed);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      captureEditorContext(e.textEditor);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        lastEditorContext &&
        e.document.uri.fsPath === lastEditorContext.filePath
      ) {
        lastEditorContext.sourceText = e.document.getText();
      }
    })
  );

  const getActiveOrLastCodeContext = (): EditorContextSnapshot | undefined => {
    const active = vscode.window.activeTextEditor;
    if (active && isCodeDocument(active.document)) {
      captureEditorContext(active);
      return lastEditorContext;
    }
    for (const visEditor of vscode.window.visibleTextEditors) {
      if (isCodeDocument(visEditor.document)) {
        if (
          !lastEditorContext ||
          visEditor.document.uri.fsPath === lastEditorContext.filePath
        ) {
          captureEditorContext(visEditor);
          return lastEditorContext;
        }
      }
    }
    for (const visEditor of vscode.window.visibleTextEditors) {
      if (isCodeDocument(visEditor.document)) {
        captureEditorContext(visEditor);
        return lastEditorContext;
      }
    }
    return lastEditorContext;
  };

  const highlightDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(249, 115, 22, 0.22)',
    border: '1px solid rgba(249, 115, 22, 0.75)',
    borderRadius: '3px',
  });

  const hoverInlineBadgeDecorationType =
    vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 14px',
        fontStyle: 'normal',
        fontWeight: '500',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

  const isLightTheme = (): boolean => {
    const kind = vscode.window.activeColorTheme.kind;
    return (
      kind === vscode.ColorThemeKind.Light ||
      kind === vscode.ColorThemeKind.HighContrastLight
    );
  };

  const setHoverInlineBadge = (
    docUri: vscode.Uri,
    lineZeroBased: number,
    text: string,
    kind: 'ok' | 'zero' | 'idle'
  ) => {
    const editor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.toString() === docUri.toString()
    );
    if (!editor) {
      return;
    }
    const lineEnd = editor.document.lineAt(
      Math.max(0, Math.min(lineZeroBased, editor.document.lineCount - 1))
    ).range.end;
    const light = isLightTheme();
    const color =
      kind === 'ok'
        ? light
          ? 'rgba(21, 128, 61, 0.78)'
          : 'rgba(74, 222, 128, 0.72)'
        : kind === 'zero'
          ? light
            ? 'rgba(185, 28, 28, 0.78)'
            : 'rgba(248, 113, 113, 0.72)'
          : light
            ? 'rgba(100, 116, 139, 0.75)'
            : 'rgba(148, 163, 184, 0.68)';
    const bgColor =
      kind === 'ok'
        ? light
          ? 'rgba(22, 163, 74, 0.025)'
          : 'rgba(34, 197, 94, 0.025)'
        : kind === 'zero'
          ? light
            ? 'rgba(220, 38, 38, 0.025)'
            : 'rgba(239, 68, 68, 0.025)'
          : light
            ? 'rgba(100, 116, 139, 0.02)'
            : 'rgba(148, 163, 184, 0.02)';
    const borderColor =
      kind === 'ok'
        ? light
          ? 'rgba(22, 163, 74, 0.09)'
          : 'rgba(34, 197, 94, 0.08)'
        : kind === 'zero'
          ? light
            ? 'rgba(220, 38, 38, 0.09)'
            : 'rgba(239, 68, 68, 0.08)'
          : light
            ? 'rgba(100, 116, 139, 0.08)'
            : 'rgba(148, 163, 184, 0.07)';

    editor.setDecorations(hoverInlineBadgeDecorationType, [
      {
        range: new vscode.Range(lineEnd, lineEnd),
        renderOptions: {
          after: {
            contentText: `  ${text}  `,
            color,
            backgroundColor: bgColor,
            border: `1px solid ${borderColor}`,
          },
        },
      },
    ]);
  };

  type GutterBadgeKind = 'ok' | 'multi' | 'zero' | 'param';
  const gutterDecorationCache = new Map<string, vscode.TextEditorDecorationType>();

  const buildGutterBadgeUri = (
    kind: GutterBadgeKind,
    label: string,
    light: boolean
  ): vscode.Uri => {
    const palette = {
      ok: light
        ? { fill: '#16a34a', fillOp: '0.08', text: '#15803d', textOp: '0.78' }
        : { fill: '#22c55e', fillOp: '0.07', text: '#4ade80', textOp: '0.72' },
      multi: light
        ? { fill: '#d97706', fillOp: '0.08', text: '#b45309', textOp: '0.78' }
        : { fill: '#f59e0b', fillOp: '0.07', text: '#fbbf24', textOp: '0.72' },
      zero: light
        ? { fill: '#dc2626', fillOp: '0.07', text: '#b91c1c', textOp: '0.72' }
        : { fill: '#ef4444', fillOp: '0.06', text: '#f87171', textOp: '0.65' },
      param: light
        ? { fill: '#0284c7', fillOp: '0.08', text: '#0369a1', textOp: '0.78' }
        : { fill: '#38bdf8', fillOp: '0.07', text: '#7dd3fc', textOp: '0.72' },
    }[kind];

    const safeLabel = label
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const fontSize =
      label.length <= 1 ? '10.5' : label.length === 2 ? '9' : '7.2';
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
      `<rect x="1" y="1.5" width="14" height="13" rx="3.5" fill="${palette.fill}" fill-opacity="${palette.fillOp}"/>` +
      `<text x="8" y="8.4" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="${fontSize}" font-weight="600" fill="${palette.text}" fill-opacity="${palette.textOp}">${safeLabel}</text>` +
      `</svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  };

  const getGutterDecorationType = (
    kind: GutterBadgeKind,
    label: string
  ): vscode.TextEditorDecorationType => {
    const key = `${kind}:${label}`;
    const existing = gutterDecorationCache.get(key);
    if (existing) {
      return existing;
    }
    const decType = vscode.window.createTextEditorDecorationType({
      gutterIconSize: 'contain',
      dark: {
        gutterIconPath: buildGutterBadgeUri(kind, label, false),
      },
      light: {
        gutterIconPath: buildGutterBadgeUri(kind, label, true),
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    gutterDecorationCache.set(key, decType);
    context.subscriptions.push(decType);
    return decType;
  };

  const clearGutterDecorationsInEditor = (editor: vscode.TextEditor): void => {
    for (const decType of gutterDecorationCache.values()) {
      editor.setDecorations(decType, []);
    }
  };

  const clearAllGutterDecorations = (): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      clearGutterDecorationsInEditor(editor);
    }
  };

  let gutterScanEpoch = 0;
  let gutterScanTimer: ReturnType<typeof setTimeout> | undefined;

  const formatGutterCountLabel = (count: number): string => {
    if (count > 99) {
      return '99+';
    }
    return String(count);
  };

  const runGutterLocatorScan = async (
    targetEditor?: vscode.TextEditor
  ): Promise<void> => {
    const epoch = ++gutterScanEpoch;
    if (!browserManager?.isPageReady() || !BrowserWebviewPanel.isOpen()) {
      clearAllGutterDecorations();
      return;
    }

    const active = targetEditor || vscode.window.activeTextEditor;
    const editorsToScan: vscode.TextEditor[] = [];
    if (active && isCodeDocument(active.document)) {
      editorsToScan.push(active);
    } else {
      for (const vis of vscode.window.visibleTextEditors) {
        if (isCodeDocument(vis.document)) {
          editorsToScan.push(vis);
          break;
        }
      }
    }

    if (editorsToScan.length === 0) {
      return;
    }

    for (const editor of editorsToScan) {
      if (epoch !== gutterScanEpoch || !BrowserWebviewPanel.isOpen()) {
        return;
      }

      const doc = editor.document;
      let collected;
      try {
        collected = collectFileLocators({
          filePath: doc.uri.fsPath,
          sourceText: doc.getText(),
        });
      } catch {
        clearGutterDecorationsInEditor(editor);
        continue;
      }

      const grouped = new Map<
        vscode.TextEditorDecorationType,
        vscode.DecorationOptions[]
      >();
      for (const decType of gutterDecorationCache.values()) {
        grouped.set(decType, []);
      }

      for (const item of collected) {
        if (epoch !== gutterScanEpoch || !BrowserWebviewPanel.isOpen()) {
          return;
        }
        const lineZero = Math.max(
          0,
          Math.min(item.line - 1, doc.lineCount - 1)
        );
        const lineStartPos = new vscode.Position(lineZero, 0);
        const range = new vscode.Range(lineStartPos, lineStartPos);
        const cmdArgs = encodeURIComponent(
          JSON.stringify([{ uri: doc.uri.toString(), line: item.line, column: item.column }])
        );
        const highlightLink = `[Highlight in browser](command:pwLocatorInspector.showLocatorAtPosition?${cmdArgs})`;

        try {
          if (
            item.requiresParameterSelection &&
            item.variants.length > 0 &&
            item.variantKind === 'context'
          ) {
            let matchedVariant = item.variants[0];
            let matchedProbe: { browserReady: boolean; count: number; visibleCount: number } = {
              browserReady: true,
              count: 0,
              visibleCount: 0,
            };
            for (const variant of item.variants) {
              if (epoch !== gutterScanEpoch || !BrowserWebviewPanel.isOpen()) {
                return;
              }
              const probe = await browserManager.probeLocatorCount(
                variant.descriptor
              );
              if (!probe.browserReady) {
                return;
              }
              if (probe.count > 0) {
                matchedVariant = variant;
                matchedProbe = probe;
                break;
              }
            }
            if (epoch !== gutterScanEpoch || !BrowserWebviewPanel.isOpen()) {
              return;
            }
            const kind: GutterBadgeKind =
              matchedProbe.count === 0
                ? 'zero'
                : matchedProbe.count === 1
                  ? 'ok'
                  : 'multi';
            const label = formatGutterCountLabel(matchedProbe.count);
            const decType = getGutterDecorationType(kind, label);
            const statusLine =
              matchedProbe.count === 0
                ? '**Not found in DOM** (`0` matches)'
                : matchedProbe.count === 1
                  ? `**Found: 1** (visible: ${matchedProbe.visibleCount}) · \`${matchedVariant.label}\``
                  : `**Found: ${matchedProbe.count}** (visible: ${matchedProbe.visibleCount}) — multiple matches · \`${matchedVariant.label}\``;
            const md = new vscode.MarkdownString(
              `${statusLine}\n\n` +
                `\`\`\`ts\n${matchedVariant.descriptor.humanReadable}\n\`\`\`\n` +
                highlightLink
            );
            md.isTrusted = true;
            const bucket = grouped.get(decType) || [];
            bucket.push({ range, hoverMessage: md });
            grouped.set(decType, bucket);
          } else if (item.requiresParameterSelection && item.variants.length > 0) {
            let matchedVariants = 0;
            for (const variant of item.variants) {
              if (epoch !== gutterScanEpoch || !BrowserWebviewPanel.isOpen()) {
                return;
              }
              const probe = await browserManager.probeLocatorCount(
                variant.descriptor
              );
              if (!probe.browserReady) {
                return;
              }
              if (probe.count > 0) {
                matchedVariants += 1;
              }
            }
            const total = item.variants.length;
            const kind: GutterBadgeKind =
              matchedVariants === 0
                ? 'zero'
                : matchedVariants === total
                  ? 'param'
                  : 'multi';
            const label = `${matchedVariants}/${total}`;
            const decType = getGutterDecorationType(kind, label);
            const md = new vscode.MarkdownString(
              `**Playwright Variants**: ${matchedVariants} of ${total} matched\n\n` +
                `\`${item.expressionText}\`\n\n` +
                highlightLink
            );
            md.isTrusted = true;
            const bucket = grouped.get(decType) || [];
            bucket.push({ range, hoverMessage: md });
            grouped.set(decType, bucket);
          } else if (item.descriptor) {
            const probe = await browserManager.probeLocatorCount(
              item.descriptor
            );
            if (!probe.browserReady) {
              return;
            }
            if (epoch !== gutterScanEpoch || !BrowserWebviewPanel.isOpen()) {
              return;
            }
            const kind: GutterBadgeKind =
              probe.count === 0 ? 'zero' : probe.count === 1 ? 'ok' : 'multi';
            const label = formatGutterCountLabel(probe.count);
            const decType = getGutterDecorationType(kind, label);
            const statusLine =
              probe.count === 0
                ? '**Not found in DOM** (`0` matches)'
                : probe.count === 1
                  ? `**Found: 1** (visible: ${probe.visibleCount})`
                  : `**Found: ${probe.count}** (visible: ${probe.visibleCount}) — multiple matches`;
            const md = new vscode.MarkdownString(
              `${statusLine}\n\n` +
                `\`\`\`ts\n${item.descriptor.humanReadable}\n\`\`\`\n` +
                highlightLink
            );
            md.isTrusted = true;
            const bucket = grouped.get(decType) || [];
            bucket.push({ range, hoverMessage: md });
            grouped.set(decType, bucket);
          }
        } catch {
          // Skip individual locator probe errors
        }
      }

      if (epoch !== gutterScanEpoch || !BrowserWebviewPanel.isOpen()) {
        return;
      }

      for (const [decType, items] of grouped.entries()) {
        editor.setDecorations(decType, items);
      }
    }
  };

  const scheduleGutterScan = (
    delayMs: number,
    targetEditor?: vscode.TextEditor
  ): void => {
    if (gutterScanTimer) {
      clearTimeout(gutterScanTimer);
      gutterScanTimer = undefined;
    }
    if (!BrowserWebviewPanel.isOpen()) {
      gutterScanEpoch += 1;
      clearAllGutterDecorations();
      return;
    }
    gutterScanTimer = setTimeout(() => {
      gutterScanTimer = undefined;
      void runGutterLocatorScan(targetEditor);
    }, delayMs);
  };

  context.subscriptions.push(
    highlightDecorationType,
    hoverInlineBadgeDecorationType,
    BrowserWebviewPanel.onDidClose(() => {
      gutterScanEpoch += 1;
      if (gutterScanTimer) {
        clearTimeout(gutterScanTimer);
        gutterScanTimer = undefined;
      }
      clearAllGutterDecorations();
      for (const ed of vscode.window.visibleTextEditors) {
        ed.setDecorations(hoverInlineBadgeDecorationType, []);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && isCodeDocument(ed.document) && BrowserWebviewPanel.isOpen()) {
        scheduleGutterScan(120, ed);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!BrowserWebviewPanel.isOpen() || !isCodeDocument(e.document)) {
        return;
      }
      const editor = vscode.window.visibleTextEditors.find(
        (ed) => ed.document.uri.toString() === e.document.uri.toString()
      );
      if (editor) {
        scheduleGutterScan(380, editor);
      }
    })
  );

  const onPageNavigated = (): void => {
    if (BrowserWebviewPanel.isOpen()) {
      scheduleGutterScan(250);
    }
  };
  browserManager.on('pageNavigated', onPageNavigated);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      browserManager?.off('pageNavigated', onPageNavigated);
    })
  );

  interface ParameterizedSession {
    baseResolved: ResolvedLocatorResult;
    reResolveWithOverrides: (
      overrides: Record<string, SerializedArg>
    ) => ResolvedLocatorResult;
  }

  let currentParameterizedSession: ParameterizedSession | undefined;

  const buildInitialHighlightPayload = async (
    resolved: ResolvedLocatorResult,
    reResolveWithOverrides: (
      overrides: Record<string, SerializedArg>
    ) => ResolvedLocatorResult
  ): Promise<{
    descriptor?: LocatorDescriptor;
    expressionLabel: string;
    parameterInfo?: HighlightParameterInfo;
  }> => {
    if (!resolved.requiresParameterSelection) {
      currentParameterizedSession = undefined;
      return {
        descriptor: resolved.descriptor,
        expressionLabel: resolved.expressionText,
      };
    }

    currentParameterizedSession = {
      baseResolved: resolved,
      reResolveWithOverrides,
    };

    let chosenVariant = resolved.variants[0];
    if (
      resolved.variants.length > 1 &&
      browserManager?.getStateSnapshot().pageReady
    ) {
      for (const variant of resolved.variants) {
        const probe = await browserManager.probeLocatorCount(variant.descriptor);
        if (!probe.browserReady) {
          break;
        }
        if (probe.count > 0) {
          chosenVariant = variant;
          break;
        }
      }
    }

    const parameterInfo: HighlightParameterInfo = {
      baseExpressionText: resolved.expressionText,
      parameterNames: resolved.parameterNames,
      activeVariantId: chosenVariant?.id,
      variants: resolved.variants.map((v) => ({
        id: v.id,
        label: v.label,
        description: v.description,
        parameters: v.parameters,
        descriptor: v.descriptor,
      })),
    };

    if (chosenVariant) {
      return {
        descriptor: chosenVariant.descriptor,
        expressionLabel: resolved.expressionText,
        parameterInfo,
      };
    }

    // Если готовых вариантов в классе не нашлось, подставляем пустую строку по умолчанию,
    // а пользователь может ввести своё значение прямо в плашке «Параметр» в браузере
    const defaultOverrides: Record<string, SerializedArg> = {};
    for (const pName of resolved.parameterNames) {
      defaultOverrides[pName] = '';
    }
    try {
      const fallbackResolved = reResolveWithOverrides(defaultOverrides);
      return {
        descriptor: fallbackResolved.descriptor,
        expressionLabel: resolved.expressionText,
        parameterInfo,
      };
    } catch {
      return {
        descriptor: resolved.descriptor,
        expressionLabel: resolved.expressionText,
        parameterInfo,
      };
    }
  };

  let handleSearchLocatorSnippet: (snippet: string) => Promise<void>;
  let handleSelectParameterVariant: (variantId: string) => Promise<void>;

  const getWorkspaceOptions = () => {
    const editor = vscode.window.activeTextEditor;
    const codeCtx = getActiveOrLastCodeContext();
    const activeFilePath = editor?.document.uri.fsPath || codeCtx?.filePath;
    const workspaceFolder =
      (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ||
      (activeFilePath &&
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activeFilePath))) ||
      vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = workspaceFolder?.uri.fsPath;

    const cfg = vscode.workspace.getConfiguration('pwLocatorInspector');
    const rawStorageState = cfg.get<string>('storageStatePath') || '';
    const storageStatePath =
      rawStorageState && workspaceRoot && !path.isAbsolute(rawStorageState)
        ? path.join(workspaceRoot, rawStorageState)
        : rawStorageState || undefined;
    const width = cfg.get<number>('viewportWidth') || 1440;
    const height = cfg.get<number>('viewportHeight') || 900;
    const readEnvFiles = cfg.get<boolean>('readEnvFiles') ?? false;

    return {
      activeFilePath,
      workspaceRoot,
      storageStatePath,
      viewport: { width, height },
      readEnvFiles,
      onSearchLocatorSnippet: (snippet: string) =>
        handleSearchLocatorSnippet(snippet),
      onSelectParameterVariant: (variantId: string) =>
        handleSelectParameterVariant(variantId),
    };
  };

  handleSelectParameterVariant = async (variantId: string): Promise<void> => {
    if (!browserManager || !currentParameterizedSession) {
      return;
    }
    const { baseResolved } = currentParameterizedSession;
    const chosen = baseResolved.variants.find((v) => v.id === variantId);
    if (!chosen) {
      return;
    }
    const parameterInfo: HighlightParameterInfo = {
      baseExpressionText: baseResolved.expressionText,
      parameterNames: baseResolved.parameterNames,
      activeVariantId: chosen.id,
      variants: baseResolved.variants.map((v) => ({
        id: v.id,
        label: v.label,
        description: v.description,
        parameters: v.parameters,
        descriptor: v.descriptor,
      })),
    };
    const highlightRes = await browserManager.highlightLocator(
      chosen.descriptor,
      {
        expressionText: baseResolved.expressionText,
        strippedActionMethod: baseResolved.strippedActionMethod,
        parameterInfo,
      }
    );
    vscode.window.setStatusBarMessage(
      `Playwright Inspector: ${highlightRes.statusText}`,
      5000
    );
  };

  handleSearchLocatorSnippet = async (snippet: string): Promise<void> => {
    if (!browserManager) {
      return;
    }
    const panel = await BrowserWebviewPanel.createOrShow(
      context,
      browserManager,
      getWorkspaceOptions()
    );

    try {
      const codeCtx = getActiveOrLastCodeContext();
      const wsOpts = getWorkspaceOptions();
      const contextFilePath =
        codeCtx?.filePath ||
        (wsOpts.workspaceRoot
          ? path.join(wsOpts.workspaceRoot, '__workspace_snippet__.ts')
          : undefined);

      const resolved = resolveLocatorFromSnippet({
        snippet,
        contextFilePath,
        contextSourceText: codeCtx?.sourceText,
        cursorLine: codeCtx?.cursorLine,
      });

      const {
        descriptor: targetDescriptor,
        expressionLabel: activeExpressionLabel,
        parameterInfo,
      } = await buildInitialHighlightPayload(resolved, (overrides) =>
        resolveLocatorFromSnippet({
          snippet,
          contextFilePath,
          contextSourceText: codeCtx?.sourceText,
          cursorLine: codeCtx?.cursorLine,
          parameterOverrides: overrides,
        })
      );

      if (!targetDescriptor) {
        const warnMsg = 'Failed to build locator descriptor.';
        panel.postSearchError(warnMsg);
        vscode.window.showWarningMessage(warnMsg);
        return;
      }

      const highlightRes = await browserManager.highlightLocator(
        targetDescriptor,
        {
          expressionText: activeExpressionLabel,
          strippedActionMethod: resolved.strippedActionMethod,
          parameterInfo,
        }
      );

      vscode.window.setStatusBarMessage(
        `Playwright Inspector: ${highlightRes.statusText}`,
        5000
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      panel.postSearchError(msg);
      vscode.window.showErrorMessage(`Playwright Locator Inspector: ${msg}`);
    }
  };

  const openBrowserCmd = vscode.commands.registerCommand(
    'pwLocatorInspector.openBrowser',
    async () => {
      if (!browserManager) {
        return;
      }
      try {
        await BrowserWebviewPanel.createOrShow(
          context,
          browserManager,
          getWorkspaceOptions()
        );
        scheduleGutterScan(200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Failed to launch Playwright browser: ${msg}`
        );
      }
    }
  );

  const resolveSelectionOrPosition = (
    doc: vscode.TextDocument,
    pos: vscode.Position,
    sel?: vscode.Selection,
    parameterOverrides?: Record<string, SerializedArg>
  ): ResolvedLocatorResult => {
    const hasSelection = Boolean(sel && !sel.isEmpty);
    if (hasSelection && sel) {
      const selection = {
        startLine: sel.start.line + 1,
        startColumn: sel.start.character + 1,
        endLine: sel.end.line + 1,
        endColumn: sel.end.character + 1,
      };
      const resolveInFile = () => resolveLocatorAtPosition({
        filePath: doc.uri.fsPath,
        sourceText: doc.getText(),
        line: pos.line + 1,
        column: pos.character + 1,
        selection,
        parameterOverrides,
      });
      let positional: ResolvedLocatorResult | undefined;
      try {
        positional = resolveInFile();
        if (positional.descriptor?.iterations) return positional;
      } catch (err) {
        if (err instanceof StaticForResolutionError) throw err;
      }
      const selectedText = doc.getText(sel).trim();
      // 1. Сначала пробуем разрезолвить ровно выделенный фрагмент кода как самостоятельный сниппет
      if (selectedText.length >= 3) {
        try {
          const snippetResolved = resolveLocatorFromSnippet({
            snippet: selectedText,
            contextFilePath: doc.uri.fsPath,
            contextSourceText: doc.getText(),
            cursorLine: sel.start.line + 1,
            parameterOverrides,
          });
          if (
            snippetResolved.descriptor ||
            snippetResolved.requiresParameterSelection
          ) {
            const selRange = {
              startLine: sel.start.line + 1,
              startColumn: sel.start.character + 1,
              endLine: sel.end.line + 1,
              endColumn: sel.end.character + 1,
            };
            return {
              ...snippetResolved,
              range: selRange,
              activeLineRanges: [selRange],
            };
          }
        } catch {
          // Фолбэк на resolveLocatorAtPosition с selection
        }
      }

      return positional ?? resolveInFile();
    }

    return resolveLocatorAtPosition({
      filePath: doc.uri.fsPath,
      sourceText: doc.getText(),
      line: pos.line + 1,
      column: pos.character + 1,
      parameterOverrides,
    });
  };

  const highlightLocatorInEditor = async (
    editor: vscode.TextEditor,
    pos: vscode.Position,
    sel?: vscode.Selection
  ): Promise<void> => {
    if (!browserManager) {
      return;
    }
    try {
      captureEditorContext(editor);
      const doc = editor.document;

      const resolved = resolveSelectionOrPosition(doc, pos, sel);

      const {
        descriptor: targetDescriptor,
        expressionLabel: activeExpressionLabel,
        parameterInfo,
      } = await buildInitialHighlightPayload(resolved, (overrides) =>
        resolveSelectionOrPosition(doc, pos, sel, overrides)
      );

      if (!targetDescriptor) {
        vscode.window.showWarningMessage('Failed to build locator descriptor.');
        return;
      }

      // Highlight active (uncommented) locator lines in the editor
      const lineRanges =
        resolved.activeLineRanges && resolved.activeLineRanges.length > 0
          ? resolved.activeLineRanges
          : [resolved.range];
      const decorationRanges = lineRanges.map(
        (r) =>
          new vscode.Range(
            new vscode.Position(r.startLine - 1, r.startColumn - 1),
            new vscode.Position(r.endLine - 1, r.endColumn - 1)
          )
      );
      editor.setDecorations(highlightDecorationType, decorationRanges);
      setTimeout(() => {
        editor.setDecorations(highlightDecorationType, []);
      }, 1800);

      const wasOpen = BrowserWebviewPanel.isOpen();
      const panel = await BrowserWebviewPanel.createOrShow(
        context,
        browserManager,
        getWorkspaceOptions()
      );
      panel.setSearchInputValue(activeExpressionLabel);
      if (!wasOpen) {
        scheduleGutterScan(200, editor);
      }

      const highlightRes = await browserManager.highlightLocator(
        targetDescriptor,
        {
          expressionText: activeExpressionLabel,
          strippedActionMethod: resolved.strippedActionMethod,
          parameterInfo,
        }
      );

      vscode.window.setStatusBarMessage(
        `Playwright Inspector: ${highlightRes.statusText}`,
        5000
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Playwright Locator Inspector: ${msg}`);
    }
  };

  const showLocatorCmd = vscode.commands.registerCommand(
    'pwLocatorInspector.showLocator',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          'Open a file with a Playwright locator in VS Code.'
        );
        return;
      }
      await highlightLocatorInEditor(
        editor,
        editor.selection.active,
        editor.selection
      );
    }
  );

  const showLocatorAtPositionCmd = vscode.commands.registerCommand(
    'pwLocatorInspector.showLocatorAtPosition',
    async (args?: { uri?: string; line?: number; column?: number }) => {
      if (!args?.uri || typeof args.line !== 'number') {
        return;
      }
      const targetUri = vscode.Uri.parse(args.uri);
      let editor = vscode.window.visibleTextEditors.find(
        (ed) => ed.document.uri.toString() === targetUri.toString()
      );
      if (!editor) {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        editor = await vscode.window.showTextDocument(doc, {
          preserveFocus: true,
        });
      }
      const pos = new vscode.Position(
        Math.max(0, args.line - 1),
        Math.max(0, (args.column || 1) - 1)
      );
      await highlightLocatorInEditor(editor, pos);
    }
  );

  // Silent DOM probe & soft inline badge on selection
  let selectionProbeTimer: ReturnType<typeof setTimeout> | undefined;
  let selectionProbeSeq = 0;
  let selectedLocatorEditor: vscode.TextEditor | undefined;

  const scheduleSelectionProbe =
    (editor: vscode.TextEditor): void => {
      if (!isCodeDocument(editor.document)) {
        return;
      }
      if (selectionProbeTimer) {
        clearTimeout(selectionProbeTimer);
      }

      const sel = editor.selection;
      if (sel.isEmpty) {
        selectionProbeSeq += 1;
        editor.setDecorations(hoverInlineBadgeDecorationType, []);
        return;
      }

      const seq = ++selectionProbeSeq;
      selectionProbeTimer = setTimeout(async () => {
        if (!browserManager || seq !== selectionProbeSeq) {
          return;
        }
        try {
          const resolved = resolveSelectionOrPosition(
            editor.document,
            sel.active,
            sel
          );
          if (seq !== selectionProbeSeq) {
            return;
          }

          const targetLine = sel.end.line;

          if (!BrowserWebviewPanel.isOpen()) {
            const hasLocatorTarget = Boolean(
              resolved.descriptor ||
                (resolved.requiresParameterSelection &&
                  resolved.variants &&
                  resolved.variants.length > 0)
            );
            if (hasLocatorTarget) {
              setHoverInlineBadge(
                editor.document.uri,
                targetLine,
                'Inspector browser is closed',
                'idle'
              );
            } else {
              editor.setDecorations(hoverInlineBadgeDecorationType, []);
            }
            return;
          }

          if (
            resolved.requiresParameterSelection &&
            resolved.variants &&
            resolved.variants.length > 0 &&
            resolved.variantKind === 'context'
          ) {
            let matchedVariant = resolved.variants[0];
            let matchedProbe: { browserReady: boolean; count: number; visibleCount: number } = {
              browserReady: true,
              count: 0,
              visibleCount: 0,
            };
            for (const variant of resolved.variants) {
              const p = await browserManager.probeLocatorCount(
                variant.descriptor
              );
              if (seq !== selectionProbeSeq) {
                return;
              }
              if (!p.browserReady) {
                editor.setDecorations(hoverInlineBadgeDecorationType, []);
                return;
              }
              if (p.count > 0) {
                matchedVariant = variant;
                matchedProbe = p;
                break;
              }
            }
            const text =
              matchedProbe.count > 0
                ? `Found in DOM: ${matchedProbe.count} (visible: ${matchedProbe.visibleCount}) [${matchedVariant.label}]`
                : 'Found in DOM: 0 (not on current page)';
            setHoverInlineBadge(
              editor.document.uri,
              targetLine,
              text,
              matchedProbe.count > 0 ? 'ok' : 'zero'
            );
            return;
          }

          if (
            resolved.requiresParameterSelection &&
            resolved.variants &&
            resolved.variants.length > 0
          ) {
            const firstProbe = await browserManager.probeLocatorCount(
              resolved.variants[0].descriptor
            );
            if (seq !== selectionProbeSeq) {
              return;
            }
            if (!firstProbe.browserReady) {
              editor.setDecorations(hoverInlineBadgeDecorationType, []);
              return;
            }
            let matched = 0;
            for (let i = 0; i < resolved.variants.length; i++) {
              const p =
                i === 0
                  ? firstProbe
                  : await browserManager.probeLocatorCount(
                      resolved.variants[i].descriptor
                    );
              if (p.count > 0) {
                matched += 1;
              }
            }
            if (seq !== selectionProbeSeq) {
              return;
            }
            const text =
              matched > 0
                ? `Found in DOM (variants): ${matched}/${resolved.variants.length}`
                : 'Found in DOM: 0 (not on current page)';
            setHoverInlineBadge(
              editor.document.uri,
              targetLine,
              text,
              matched > 0 ? 'ok' : 'zero'
            );
            return;
          }

          const targetDescriptor = resolved.descriptor;
          if (!targetDescriptor) {
            editor.setDecorations(hoverInlineBadgeDecorationType, []);
            return;
          }

          const probe = await browserManager.probeLocatorCount(targetDescriptor);
          if (seq !== selectionProbeSeq) {
            return;
          }

          if (!probe.browserReady) {
            editor.setDecorations(hoverInlineBadgeDecorationType, []);
          } else if (probe.count > 0) {
            setHoverInlineBadge(
              editor.document.uri,
              targetLine,
              `Found in DOM: ${probe.count} (visible: ${probe.visibleCount})`,
              'ok'
            );
          } else {
            setHoverInlineBadge(
              editor.document.uri,
              targetLine,
              'Found in DOM: 0 (not on current page)',
              'zero'
            );
          }
        } catch {
          if (seq === selectionProbeSeq) {
            editor.setDecorations(hoverInlineBadgeDecorationType, []);
          }
        }
      }, 160);
    };

  const refreshSelectedLocator = (): void => {
    if (!BrowserWebviewPanel.isOpen()) {
      return;
    }
    const editor = selectedLocatorEditor;
    if (editor && vscode.window.visibleTextEditors.includes(editor) && !editor.selection.isEmpty) {
      scheduleSelectionProbe(editor);
    }
  };

  const refreshForPageChange = (delay: number): void => {
    if (BrowserWebviewPanel.isOpen()) {
      const editor = selectedLocatorEditor;
      scheduleGutterScan(delay, editor && vscode.window.visibleTextEditors.includes(editor) ? editor : undefined);
      refreshSelectedLocator();
    }
  };
  const onViewportChanged = () => refreshForPageChange(250);
  const onDomChanged = () => refreshForPageChange(50);
  browserManager.on('viewportChanged', onViewportChanged);
  browserManager.on('domChanged', onDomChanged);

  const selectionRefreshEvents = ['browserReady', 'pageNavigated', 'highlightChanged'];
  for (const event of selectionRefreshEvents) {
    browserManager.on(event, refreshSelectedLocator);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
      if (isCodeDocument(textEditor.document)) {
        if (!textEditor.selection.isEmpty) {
          selectedLocatorEditor = textEditor;
        } else if (selectedLocatorEditor === textEditor) {
          selectedLocatorEditor = undefined;
        }
      }
      scheduleSelectionProbe(textEditor);
    }),
    new vscode.Disposable(() => {
      browserManager?.off('viewportChanged', onViewportChanged);
      browserManager?.off('domChanged', onDomChanged);
      for (const event of selectionRefreshEvents) {
        browserManager?.off(event, refreshSelectedLocator);
      }
      selectionProbeSeq += 1;
      clearTimeout(selectionProbeTimer);
    })
  );

  context.subscriptions.push(
    openBrowserCmd,
    showLocatorCmd,
    showLocatorAtPositionCmd
  );

  // Watch for newly installed .vsix versions in VS Code extensions folder
  const currentExtDirName = path.basename(context.extensionPath);
  const extensionsParentDir = path.dirname(context.extensionPath);
  const extPrefix = `${context.extension.id}-`;
  let reloadPromptShown = false;

  if (fs.existsSync(extensionsParentDir)) {
    try {
      const watcher = fs.watch(extensionsParentDir, (_eventType, filename) => {
        if (
          !reloadPromptShown &&
          typeof filename === 'string' &&
          filename.startsWith(extPrefix) &&
          filename !== currentExtDirName
        ) {
          const fullNewPath = path.join(extensionsParentDir, filename);
          if (fs.existsSync(fullNewPath)) {
            reloadPromptShown = true;
            const newVer = filename.slice(extPrefix.length);
            vscode.window
              .showInformationMessage(
                `A new version of Playwright Locator Inspector (${newVer}) has been installed. Reload the VS Code window to apply changes.`,
                'Reload Window'
              )
              .then((choice) => {
                if (choice === 'Reload Window') {
                  vscode.commands.executeCommand(
                    'workbench.action.reloadWindow'
                  );
                } else {
                  reloadPromptShown = false;
                }
              });
          }
        }
      });
      context.subscriptions.push(
        new vscode.Disposable(() => {
          watcher.close();
        })
      );
    } catch {
      // ignore
    }
  }
}

export async function deactivate(): Promise<void> {
  if (browserManager) {
    await browserManager.dispose();
    browserManager = undefined;
  }
}
