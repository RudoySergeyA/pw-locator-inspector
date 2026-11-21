import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import * as ts from 'typescript';

export interface PlaywrightConfigSettings {
  projectRoot: string;
  configPath?: string;
  testIdAttribute: string;
  baseURL?: string;
  ignoreHTTPSErrors: boolean;
  viewport: {
    width: number;
    height: number;
  };
  extraHTTPHeaders?: Record<string, string>;
  launchArgs: string[];
  defaultStorageStatePath?: string;
}

export interface StorageStateCandidate {
  label: string;
  relativePath: string;
  fullPath: string;
  cookiesCount: number;
  originsCount: number;
}

export interface WorkspacePlaywrightRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  playwrightModule: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chromium: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectors: any;
  packageName: string;
  packagePath: string;
  projectRoot: string;
  config: PlaywrightConfigSettings;
}

export interface LoadPlaywrightConfigOptions {
  /** Разрешить чтение нечувствительных переменных из .env-файлов проекта (по умолчанию false). */
  readEnvFiles?: boolean;
}

const CONFIG_FILE_NAMES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

const SENSITIVE_ENV_KEY_REGEX =
  /(secret|token|pass|pwd|password|key|auth|cookie|session|jwt|bearer|cred|credential|private|cert|pem|signature|hash|dsn|connection_string)/i;

const SENSITIVE_HEADER_NAME_REGEX =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$|(secret|token|auth|key|pass|cookie|session|cred)/i;

const SENSITIVE_JSON_FILENAME_REGEX =
  /(secret|credential|service[-_]?account|private|passwd|password|apikey|api[-_]?key)/i;

const IGNORED_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'allure-results',
  'allure-report',
  'playwright-report',
  'test-results',
  '.vscode',
  '.idea',
]);

/**
 * Ищет корень Playwright-проекта, поднимаясь вверх от активного файла до корня воркспейса.
 */
export function findPlaywrightProjectRoot(
  startPath?: string,
  fallbackWorkspaceRoot?: string
): string {
  const candidates: string[] = [];
  if (startPath) {
    try {
      const stat = fs.existsSync(startPath) ? fs.statSync(startPath) : undefined;
      candidates.push(stat && stat.isDirectory() ? startPath : path.dirname(startPath));
    } catch {
      candidates.push(path.dirname(startPath));
    }
  }
  if (fallbackWorkspaceRoot) {
    candidates.push(fallbackWorkspaceRoot);
  }

  let firstPackageJsonDir: string | undefined;

  for (const startDir of candidates) {
    let current = path.resolve(startDir);
    while (true) {
      for (const cfgName of CONFIG_FILE_NAMES) {
        if (fs.existsSync(path.join(current, cfgName))) {
          return current;
        }
      }
      if (!firstPackageJsonDir && fs.existsSync(path.join(current, 'package.json'))) {
        firstPackageJsonDir = current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return firstPackageJsonDir || fallbackWorkspaceRoot || process.cwd();
}

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_REGEX.test(key);
}

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAME_REGEX.test(name.trim());
}

/**
 * Проверяет, что URL использует http/https и не содержит встроенных учётных данных (user:pass@).
 */
export function sanitizeBaseUrl(rawUrl?: string): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    if (parsed.username || parsed.password) {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Читает только нечувствительные переменные окружения (без секретов, токенов, паролей и ключей)
 * без модификации глобального process.env. Файлы .env* читаются только при readEnvFiles === true.
 */
function loadProjectEnvVars(
  projectRoot: string,
  readEnvFiles: boolean
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val === 'string' && !isSensitiveEnvKey(key)) {
      result[key] = val;
    }
  }

  if (!readEnvFiles) {
    return result;
  }

  const envFiles = [
    process.env.ENV_PATH,
    '.env',
    '.env.local',
    '.env.test',
    '.env.qa',
    '.env.dev',
  ].filter((item): item is string => Boolean(item));

  for (const envFile of envFiles) {
    const fullPath = path.isAbsolute(envFile)
      ? envFile
      : path.join(projectRoot, envFile);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
          continue;
        }
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) {
          continue;
        }
        const key = line.slice(0, eqIdx).trim();
        if (!key || isSensitiveEnvKey(key)) {
          continue;
        }
        let value = line.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in result)) {
          result[key] = value;
        }
      }
    } catch {
      // Игнорируем нечитаемые .env файлы
    }
  }

  return result;
}

/**
 * Извлекает настройки из playwright.config.ts с помощью TypeScript AST.
 */
export function loadPlaywrightConfigSettings(
  projectRoot: string,
  options?: LoadPlaywrightConfigOptions
): PlaywrightConfigSettings {
  const readEnvFiles = Boolean(options?.readEnvFiles);
  const settings: PlaywrightConfigSettings = {
    projectRoot,
    testIdAttribute: 'data-testid',
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    launchArgs: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
    ],
  };

  let configPath: string | undefined;
  for (const cfgName of CONFIG_FILE_NAMES) {
    const full = path.join(projectRoot, cfgName);
    if (fs.existsSync(full)) {
      configPath = full;
      break;
    }
  }

  const envVars = loadProjectEnvVars(projectRoot, readEnvFiles);
  const envBaseUrl = sanitizeBaseUrl(envVars.QA_URL || envVars.BASE_URL);
  if (envBaseUrl) {
    settings.baseURL = envBaseUrl;
  }

  if (!configPath) {
    return settings;
  }

  settings.configPath = configPath;

  try {
    const code = fs.readFileSync(configPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      configPath,
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const topLevelConsts = new Map<string, unknown>();

    const evalSimpleNode = (
      node: ts.Node | undefined,
      allowEnvLookup: boolean = true
    ): unknown => {
      if (!node) {
        return undefined;
      }
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
        return evalSimpleNode(node.expression, allowEnvLookup);
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
      }
      if (ts.isNumericLiteral(node)) {
        return Number(node.text);
      }
      if (node.kind === ts.SyntaxKind.TrueKeyword) {
        return true;
      }
      if (node.kind === ts.SyntaxKind.FalseKeyword) {
        return false;
      }
      if (ts.isIdentifier(node)) {
        if (allowEnvLookup && topLevelConsts.has(node.text)) {
          return topLevelConsts.get(node.text);
        }
        return undefined;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'process' &&
        node.expression.name.text === 'env'
      ) {
        if (!allowEnvLookup || isSensitiveEnvKey(node.name.text)) {
          return undefined;
        }
        return envVars[node.name.text];
      }
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        const left = evalSimpleNode(node.left, allowEnvLookup);
        return left !== undefined && left !== ''
          ? left
          : evalSimpleNode(node.right, allowEnvLookup);
      }
      if (ts.isArrayLiteralExpression(node)) {
        return node.elements
          .map((el) => evalSimpleNode(el, allowEnvLookup))
          .filter((v) => v !== undefined);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const obj: Record<string, unknown> = {};
        for (const prop of node.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const key =
              ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
                ? prop.name.text
                : undefined;
            if (key) {
              obj[key] = evalSimpleNode(prop.initializer, allowEnvLookup);
            }
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            const key = prop.name.text;
            obj[key] = allowEnvLookup ? topLevelConsts.get(key) : undefined;
          }
        }
        return obj;
      }
      return undefined;
    };

    for (const stmt of sourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            !isSensitiveEnvKey(decl.name.text)
          ) {
            const val = evalSimpleNode(decl.initializer, true);
            if (val !== undefined) {
              topLevelConsts.set(decl.name.text, val);
            }
          }
        }
      }
    }

    const inspectUseObject = (useObj: ts.ObjectLiteralExpression) => {
      for (const prop of useObj.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const propName =
            ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
              ? prop.name.text
              : '';

          if (propName === 'extraHTTPHeaders') {
            // Запрещаем подстановку process.env и отбрасываем любые чувствительные заголовки
            const rawHeaders = evalSimpleNode(prop.initializer, false);
            if (
              rawHeaders &&
              typeof rawHeaders === 'object' &&
              !Array.isArray(rawHeaders)
            ) {
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(
                rawHeaders as Record<string, unknown>
              )) {
                if (typeof v === 'string' && !isSensitiveHeaderName(k)) {
                  headers[k] = v;
                }
              }
              if (Object.keys(headers).length > 0) {
                settings.extraHTTPHeaders = headers;
              }
            }
            continue;
          }

          const val = evalSimpleNode(prop.initializer, true);

          if (propName === 'testIdAttribute' && typeof val === 'string' && val.trim()) {
            settings.testIdAttribute = val.trim();
          } else if (propName === 'baseURL' && typeof val === 'string') {
            const safeUrl = sanitizeBaseUrl(val);
            if (safeUrl) {
              settings.baseURL = safeUrl;
            }
          } else if (propName === 'ignoreHTTPSErrors' && typeof val === 'boolean') {
            settings.ignoreHTTPSErrors = val;
          } else if (
            propName === 'viewport' &&
            val &&
            typeof val === 'object' &&
            !Array.isArray(val)
          ) {
            const vp = val as Record<string, unknown>;
            if (typeof vp.width === 'number' && typeof vp.height === 'number') {
              settings.viewport = { width: vp.width, height: vp.height };
            }
          } else if (
            propName === 'launchOptions' &&
            ts.isObjectLiteralExpression(prop.initializer)
          ) {
            for (const loProp of prop.initializer.properties) {
              if (
                ts.isPropertyAssignment(loProp) &&
                (ts.isIdentifier(loProp.name) || ts.isStringLiteral(loProp.name)) &&
                loProp.name.text === 'args'
              ) {
                const argsVal = evalSimpleNode(loProp.initializer, true);
                if (Array.isArray(argsVal) && argsVal.every((x) => typeof x === 'string')) {
                  settings.launchArgs = argsVal as string[];
                }
              }
            }
          }
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          if (prop.name.text === 'baseURL') {
            const val = topLevelConsts.get('baseURL');
            if (typeof val === 'string') {
              const safeUrl = sanitizeBaseUrl(val);
              if (safeUrl) {
                settings.baseURL = safeUrl;
              }
            }
          }
        }
      }
    };

    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === 'use' &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        inspectUseObject(node.initializer);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  } catch {
    // Оставляем дефолтные настройки при ошибке чтения конфига
  }

  const authDirs = [
    path.join(projectRoot, '.auth'),
    path.join(projectRoot, 'playwright', '.auth'),
  ];
  for (const authDir of authDirs) {
    if (!fs.existsSync(authDir)) {
      continue;
    }
    try {
      const files = fs
        .readdirSync(authDir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      for (const file of files) {
        const candidate = path.join(authDir, file);
        if (isValidPlaywrightStorageStateFile(candidate).valid) {
          settings.defaultStorageStatePath = candidate;
          break;
        }
      }
      if (settings.defaultStorageStatePath) {
        break;
      }
    } catch {
      // ignore
    }
  }

  return settings;
}

/**
 * Проверяет, что JSON-файл соответствует схеме Playwright storageState
 * (содержит валидный массив cookies и/или валидный массив origins).
 * Исключает посторонние JSON-файлы вроде personal-user.json и test-user.json.
 */
export function isValidPlaywrightStorageStateFile(filePath: string): {
  valid: boolean;
  cookiesCount: number;
  originsCount: number;
} {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, cookiesCount: 0, originsCount: 0 };
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 15 * 1024 * 1024) {
      return { valid: false, cookiesCount: 0, originsCount: 0 };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { valid: false, cookiesCount: 0, originsCount: 0 };
    }

    const hasCookiesKey = 'cookies' in parsed;
    const hasOriginsKey = 'origins' in parsed;

    if (!hasCookiesKey && !hasOriginsKey) {
      return { valid: false, cookiesCount: 0, originsCount: 0 };
    }

    let cookiesCount = 0;
    let originsCount = 0;

    if (hasCookiesKey) {
      if (!Array.isArray(parsed.cookies)) {
        return { valid: false, cookiesCount: 0, originsCount: 0 };
      }
      for (const cookie of parsed.cookies) {
        if (
          !cookie ||
          typeof cookie !== 'object' ||
          typeof cookie.name !== 'string' ||
          typeof cookie.value !== 'string' ||
          typeof cookie.domain !== 'string'
        ) {
          return { valid: false, cookiesCount: 0, originsCount: 0 };
        }
      }
      cookiesCount = parsed.cookies.length;
    }

    if (hasOriginsKey) {
      if (!Array.isArray(parsed.origins)) {
        return { valid: false, cookiesCount: 0, originsCount: 0 };
      }
      for (const originEntry of parsed.origins) {
        if (
          !originEntry ||
          typeof originEntry !== 'object' ||
          typeof originEntry.origin !== 'string' ||
          !Array.isArray(originEntry.localStorage)
        ) {
          return { valid: false, cookiesCount: 0, originsCount: 0 };
        }
      }
      originsCount = parsed.origins.length;
    }

    return {
      valid: true,
      cookiesCount,
      originsCount,
    };
  } catch {
    return { valid: false, cookiesCount: 0, originsCount: 0 };
  }
}

/**
 * Сканирует проект и возвращает только валидные файлы Playwright storageState (.json).
 */
export function discoverStorageStateFiles(projectRoot: string): StorageStateCandidate[] {
  const found = new Map<string, StorageStateCandidate>();

  const checkFile = (fullPath: string) => {
    const resolved = path.resolve(fullPath);
    if (found.has(resolved) || !resolved.endsWith('.json')) {
      return;
    }
    const baseName = path.basename(resolved);
    if (
      baseName === 'package.json' ||
      baseName === 'package-lock.json' ||
      baseName.startsWith('tsconfig') ||
      SENSITIVE_JSON_FILENAME_REGEX.test(baseName)
    ) {
      return;
    }
    const validation = isValidPlaywrightStorageStateFile(resolved);
    if (!validation.valid) {
      return;
    }
    const relativePath = path.relative(projectRoot, resolved);
    found.set(resolved, {
      label: relativePath,
      relativePath,
      fullPath: resolved,
      cookiesCount: validation.cookiesCount,
      originsCount: validation.originsCount,
    });
  };

  // Приоритетные папки для авторизационных сессий
  const priorityDirs = [
    path.join(projectRoot, '.auth'),
    path.join(projectRoot, 'playwright', '.auth'),
    path.join(projectRoot, 'auth'),
    path.join(projectRoot, 'e2e', '.auth'),
    path.join(projectRoot, 'tests', '.auth'),
  ];

  for (const dir of priorityDirs) {
    if (fs.existsSync(dir)) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.json')) {
            checkFile(path.join(dir, entry.name));
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Общий обход проекта с ограничением глубины
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(dir)) {
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SCAN_DIRS.has(entry.name)) {
          continue;
        }
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        checkFile(fullPath);
      }
    }
  };

  walk(projectRoot, 0);

  return Array.from(found.values()).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}

/**
 * Динамически подключает @playwright/test / playwright / playwright-core из node_modules
 * открытого проекта (относительно активного файла с fallback на корень воркспейса)
 * и настраивает selectors.setTestIdAttribute из playwright.config.ts.
 */
export function resolveWorkspacePlaywright(
  activeFilePath?: string,
  workspaceRoot?: string,
  options?: LoadPlaywrightConfigOptions
): WorkspacePlaywrightRuntime {
  const projectRoot = findPlaywrightProjectRoot(activeFilePath, workspaceRoot);
  const config = loadPlaywrightConfigSettings(projectRoot, options);

  const anchorPaths: string[] = [];
  if (activeFilePath) {
    const dir =
      fs.existsSync(activeFilePath) && fs.statSync(activeFilePath).isDirectory()
        ? activeFilePath
        : path.dirname(activeFilePath);
    anchorPaths.push(path.join(dir, 'package.json'));
  }
  anchorPaths.push(path.join(projectRoot, 'package.json'));
  if (workspaceRoot) {
    anchorPaths.push(path.join(workspaceRoot, 'package.json'));
  }

  const packageNames = ['@playwright/test', 'playwright', 'playwright-core'];

  for (const anchor of anchorPaths) {
    let req: NodeRequire;
    try {
      req = createRequire(anchor);
    } catch {
      continue;
    }
    for (const pkgName of packageNames) {
      try {
        const resolvedPath = req.resolve(pkgName);
        const pwMod = req(resolvedPath);
        const chromium = pwMod.chromium || pwMod.default?.chromium;
        const selectors = pwMod.selectors || pwMod.default?.selectors;
        if (chromium && selectors) {
          if (config.testIdAttribute) {
            selectors.setTestIdAttribute(config.testIdAttribute);
          }
          return {
            playwrightModule: pwMod,
            chromium,
            selectors,
            packageName: pkgName,
            packagePath: resolvedPath,
            projectRoot,
            config,
          };
        }
      } catch {
        // Пробуем следующий пакет или anchor
      }
    }
  }

  throw new Error(
    `Could not find @playwright/test, playwright, or playwright-core in project node_modules (${projectRoot}). Run npm install in the project directory.`
  );
}
