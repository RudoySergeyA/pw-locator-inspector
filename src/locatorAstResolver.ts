import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type LocatorMethodName =
  | 'locator'
  | 'getByRole'
  | 'getByText'
  | 'getByLabel'
  | 'getByPlaceholder'
  | 'getByAltText'
  | 'getByTitle'
  | 'getByTestId'
  | 'filter'
  | 'first'
  | 'last'
  | 'nth'
  | 'and'
  | 'or'
  | 'frameLocator'
  | 'contentFrame';

export interface SerializedRegExp {
  __kind: 'regexp';
  source: string;
  flags: string;
}

export interface SerializedNestedLocator {
  __kind: 'locator';
  descriptor: LocatorDescriptor;
}

export type SerializedArg =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializedRegExp
  | SerializedNestedLocator
  | SerializedArg[]
  | { [key: string]: SerializedArg };

export interface LocatorStep {
  method: LocatorMethodName;
  args: SerializedArg[];
}

export interface LocatorDescriptor {
  steps: LocatorStep[];
  humanReadable: string;
  /** Отдельные цепочки, объединённые этим дескриптором. */
  iterations?: LocatorDescriptor[];
}

export class StaticForResolutionError extends Error {}

const MAX_STATIC_FOR_ITERATIONS = 100;
const MISSING_LOOP_VALUE = 'static for: missing value';
class LoopEvaluation extends Set<string> {}

export interface LocatorVariant {
  id: string;
  label: string;
  description?: string;
  parameters: Record<string, SerializedArg>;
  descriptor: LocatorDescriptor;
}

export interface ResolveLocatorOptions {
  filePath: string;
  sourceText?: string;
  /** 1-based номер строки */
  line: number;
  /** 1-based номер колонки */
  column: number;
  /** Опциональный диапазон выделения (1-based) */
  selection?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  /** Значения параметров для параметризованных методов/хелперов */
  parameterOverrides?: Record<string, SerializedArg>;
}

export interface ResolveLocatorSnippetOptions {
  /** Вставленное выражение локатора, присваивание, цепочка или CSS/XPath селектор */
  snippet: string;
  /** Путь к открытому или последнему активному файлу проекта для резолва this.*, констант и переменных */
  contextFilePath?: string;
  /** Текст контекстного файла (если есть несохранённые правки в редакторе) */
  contextSourceText?: string;
  /** 1-based строка курсора в контекстном файле */
  cursorLine?: number;
  /** Значения параметров для параметризованных методов/хелперов */
  parameterOverrides?: Record<string, SerializedArg>;
}

export interface SourceLineRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ResolvedLocatorResult {
  /** Имя выражения в исходном коде (например, this.contentRoot или this.profileSection.saveButton) */
  expressionText: string;
  /** Диапазон выбранного узла в исходном файле (1-based) */
  range: SourceLineRange;
  /** Активные (незакомментированные) диапазоны строк для точной подсветки в редакторе без // строк */
  activeLineRanges?: SourceLineRange[];
  /** Был ли отрезан терминальный метод действия (.click(), .fill() и т.д.) */
  strippedActionMethod?: string;
  /** Готовый дескриптор локатора (если не требуется выбор варианта или выбран вариант) */
  descriptor?: LocatorDescriptor;
  /** Требуется ли выбор варианта вызова / ввод параметра пользователем */
  requiresParameterSelection: boolean;
  /** Список имён параметров, от которых зависит локатор */
  parameterNames: string[];
  /** Тип вариантов: параметры метода/хелпера или контексты классов-наследников */
  variantKind?: 'parameter' | 'context';
  /** Готовые варианты (из вызовов хелпера в классе, из массивов констант или из super() наследников) */
  variants: LocatorVariant[];
}

const LOCATOR_ROOT_METHODS = new Set<string>([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'frameLocator',
]);

const LOCATOR_CHAIN_METHODS = new Set<string>([
  ...LOCATOR_ROOT_METHODS,
  'filter',
  'first',
  'last',
  'nth',
  'and',
  'or',
  'contentFrame',
]);

/**
 * Терминальные действия и проверки на Locator, которые имеют побочные эффекты
 * или возвращают Promise вместо Locator — они безопасно отрезаются.
 */
const TERMINAL_ACTION_METHODS = new Set<string>([
  'click',
  'dblclick',
  'tap',
  'fill',
  'clear',
  'type',
  'press',
  'pressSequentially',
  'check',
  'uncheck',
  'setChecked',
  'hover',
  'focus',
  'blur',
  'selectOption',
  'setInputFiles',
  'dispatchEvent',
  'dragTo',
  'scrollIntoViewIfNeeded',
  'waitFor',
  'highlight',
  'screenshot',
  'ariaSnapshot',
  'boundingBox',
  'count',
  'all',
  'allInnerTexts',
  'allTextContents',
  'innerHTML',
  'innerText',
  'textContent',
  'inputValue',
  'getAttribute',
  'isChecked',
  'isDisabled',
  'isEditable',
  'isEnabled',
  'isHidden',
  'isVisible',
  'evaluate',
  'evaluateAll',
  'evaluateHandle',
  'elementHandle',
  'elementHandles',
]);

type AstValue =
  | { kind: 'page' }
  | { kind: 'locator'; descriptor: LocatorDescriptor }
  | { kind: 'primitive'; value: string | number | boolean | null | undefined }
  | { kind: 'regexp'; source: string; flags: string }
  | { kind: 'array'; elements: AstValue[] }
  | { kind: 'object'; properties: Map<string, AstValue> }
  | {
      kind: 'function';
      name: string;
      node:
        | ts.ArrowFunction
        | ts.FunctionExpression
        | ts.FunctionDeclaration
        | ts.MethodDeclaration;
      env: ScopeEnv;
    }
  | {
      kind: 'classInstance';
      className: string;
      props: Map<string, AstValue>;
      methods: Map<string, ts.MethodDeclaration>;
      classEnv: ScopeEnv;
      ctorEnv?: ScopeEnv;
    }
  | { kind: 'unresolvedParam'; paramName: string };

interface FunctionCallRecord {
  callerName: string;
  description?: string;
  argsByName: Record<string, AstValue>;
}

interface ScopeEnv {
  vars: Map<string, AstValue>;
  parent?: ScopeEnv;
}

function createEnv(parent?: ScopeEnv): ScopeEnv {
  return {
    vars: new Map<string, AstValue>(),
    parent,
  };
}

function cloneEnv(env: ScopeEnv): ScopeEnv {
  return {
    vars: new Map(env.vars),
    parent: env.parent ? cloneEnv(env.parent) : undefined,
  };
}

function lookupEnv(env: ScopeEnv | undefined, name: string): AstValue | undefined {
  let cur = env;
  while (cur) {
    if (cur.vars.has(name)) {
      return cur.vars.get(name);
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Форматирует сериализованный аргумент в читаемый TypeScript-код для отображения пользователю.
 */
function formatSerializedArg(arg: SerializedArg): string {
  if (arg === null) {
    return 'null';
  }
  if (arg === undefined) {
    return 'undefined';
  }
  if (typeof arg === 'string') {
    return JSON.stringify(arg);
  }
  if (typeof arg === 'number' || typeof arg === 'boolean') {
    return String(arg);
  }
  if (Array.isArray(arg)) {
    return `[${arg.map(formatSerializedArg).join(', ')}]`;
  }
  if (typeof arg === 'object') {
    if ('__kind' in arg && arg.__kind === 'regexp') {
      const rx = arg as SerializedRegExp;
      return `/${rx.source}/${rx.flags}`;
    }
    if ('__kind' in arg && arg.__kind === 'locator') {
      const loc = arg as SerializedNestedLocator;
      return loc.descriptor.humanReadable;
    }
    const entries = Object.entries(arg).filter(([, v]) => v !== undefined);
    const inner = entries
      .map(([k, v]) => `${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${formatSerializedArg(v)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  return String(arg);
}

/**
 * Строит читаемое представление цепочки локатора.
 */
export function formatLocatorSteps(steps: LocatorStep[]): string {
  const parts = ['page'];
  for (const step of steps) {
    const formattedArgs = step.args.map(formatSerializedArg).join(', ');
    parts.push(`.${step.method}(${formattedArgs})`);
  }
  return parts.join('');
}

/**
 * Материализует LocatorDescriptor в настоящий Playwright Locator на переданном объекте Page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function materializeLocator(page: any, descriptor: LocatorDescriptor): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hydrateArg = (arg: SerializedArg): any => {
    if (arg === null || arg === undefined) {
      return arg;
    }
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
      return arg;
    }
    if (Array.isArray(arg)) {
      return arg.map(hydrateArg);
    }
    if (typeof arg === 'object') {
      if ('__kind' in arg && arg.__kind === 'regexp') {
        const rx = arg as SerializedRegExp;
        return new RegExp(rx.source, rx.flags);
      }
      if ('__kind' in arg && arg.__kind === 'locator') {
        const nested = arg as SerializedNestedLocator;
        return materializeLocator(page, nested.descriptor);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj: Record<string, any> = {};
      for (const [k, v] of Object.entries(arg)) {
        obj[k] = hydrateArg(v);
      }
      return obj;
    }
    return arg;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = page;
  for (const step of descriptor.steps) {
    const hydratedArgs = step.args.map(hydrateArg);
    if (typeof current[step.method] !== 'function') {
      throw new Error(`Locator method "${step.method}" is not supported on the current target.`);
    }
    current = current[step.method](...hydratedArgs);
  }
  return current;
}

/**
 * Конвертирует AstValue в сериализуемый аргумент SerializedArg.
 * Если внутри встречается unresolvedParam, добавляет имя параметра в список unresolvedParams.
 */
function astValueToSerializedArg(
  val: AstValue | undefined,
  unresolvedParams: Set<string>
): SerializedArg {
  if (!val) {
    if (unresolvedParams instanceof LoopEvaluation) unresolvedParams.add(MISSING_LOOP_VALUE);
    return undefined;
  }
  switch (val.kind) {
    case 'primitive':
      return val.value;
    case 'regexp':
      return {
        __kind: 'regexp',
        source: val.source,
        flags: val.flags,
      };
    case 'locator':
      return {
        __kind: 'locator',
        descriptor: val.descriptor,
      };
    case 'array':
      return val.elements.map((el) => astValueToSerializedArg(el, unresolvedParams));
    case 'object': {
      const obj: { [key: string]: SerializedArg } = {};
      for (const [k, v] of val.properties.entries()) {
        obj[k] = astValueToSerializedArg(v, unresolvedParams);
      }
      return obj;
    }
    case 'unresolvedParam':
      unresolvedParams.add(val.paramName);
      return `__PARAM_${val.paramName}__`;
    default:
      return undefined;
  }
}

function serializedArgToAstValue(arg: SerializedArg): AstValue {
  if (
    arg === null ||
    arg === undefined ||
    typeof arg === 'string' ||
    typeof arg === 'number' ||
    typeof arg === 'boolean'
  ) {
    return { kind: 'primitive', value: arg };
  }
  if (Array.isArray(arg)) {
    return { kind: 'array', elements: arg.map(serializedArgToAstValue) };
  }
  if (typeof arg === 'object') {
    if ('__kind' in arg && arg.__kind === 'regexp') {
      const rx = arg as SerializedRegExp;
      return { kind: 'regexp', source: rx.source, flags: rx.flags };
    }
    if ('__kind' in arg && arg.__kind === 'locator') {
      const loc = arg as SerializedNestedLocator;
      return { kind: 'locator', descriptor: loc.descriptor };
    }
    const map = new Map<string, AstValue>();
    for (const [k, v] of Object.entries(arg)) {
      map.set(k, serializedArgToAstValue(v));
    }
    return { kind: 'object', properties: map };
  }
  return { kind: 'primitive', value: undefined };
}

function unwrapParensAndTypes(node: ts.Node): ts.Node {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isAwaitExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Резолвит импортированный модуль относительно текущего файла (включая tsconfig paths при наличии).
 */
function resolveImportFilePath(fromFile: string, moduleSpecifier: string): string | undefined {
  const fromDir = path.dirname(fromFile);
  const candidates: string[] = [];

  if (moduleSpecifier.startsWith('.')) {
    const base = path.resolve(fromDir, moduleSpecifier);
    candidates.push(
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.mjs`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.js')
    );
  } else {
    // Пробуем найти tsconfig.json для baseUrl / paths
    let curDir = fromDir;
    while (true) {
      const tsconfigPath = path.join(curDir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
        try {
          const parsedConfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
          const compilerOptions = parsedConfig.config?.compilerOptions || {};
          const baseUrl = compilerOptions.baseUrl
            ? path.resolve(curDir, compilerOptions.baseUrl)
            : curDir;
          if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
            for (const [pattern, mappings] of Object.entries(compilerOptions.paths)) {
              if (!Array.isArray(mappings)) {
                continue;
              }
              const starIdx = pattern.indexOf('*');
              if (starIdx !== -1) {
                const prefix = pattern.slice(0, starIdx);
                const suffix = pattern.slice(starIdx + 1);
                if (
                  moduleSpecifier.startsWith(prefix) &&
                  moduleSpecifier.endsWith(suffix)
                ) {
                  const matchedStar = moduleSpecifier.slice(
                    prefix.length,
                    moduleSpecifier.length - suffix.length
                  );
                  for (const target of mappings) {
                    if (typeof target === 'string') {
                      const mapped = path.resolve(
                        baseUrl,
                        target.replace('*', matchedStar)
                      );
                      candidates.push(
                        mapped,
                        `${mapped}.ts`,
                        `${mapped}.tsx`,
                        `${mapped}.js`,
                        path.join(mapped, 'index.ts')
                      );
                    }
                  }
                }
              } else if (pattern === moduleSpecifier) {
                for (const target of mappings) {
                  if (typeof target === 'string') {
                    const mapped = path.resolve(baseUrl, target);
                    candidates.push(mapped, `${mapped}.ts`, path.join(mapped, 'index.ts'));
                  }
                }
              }
            }
          }
          const directFromBase = path.resolve(baseUrl, moduleSpecifier);
          candidates.push(
            directFromBase,
            `${directFromBase}.ts`,
            path.join(directFromBase, 'index.ts')
          );
        } catch {
          // ignore
        }
        break;
      }
      const parent = path.dirname(curDir);
      if (parent === curDir) {
        break;
      }
      curDir = parent;
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

const IGNORED_IMPORT_SYMBOLS = new Set([
  'test',
  'expect',
  'Page',
  'Locator',
  'BrowserContext',
  'APIRequestContext',
  'TestInfo',
]);

class ModuleAstLoader {
  private moduleExportCache = new Map<string, Map<string, AstValue>>();
  private loadingFiles = new Set<string>();
  public readonly visitedClassFiles = new Set<string>();

  public getModuleExports(filePath: string): Map<string, AstValue> {
    const resolved = path.resolve(filePath);
    const cached = this.moduleExportCache.get(resolved);
    if (cached) {
      return cached;
    }
    const exportsMap = new Map<string, AstValue>();
    if (this.loadingFiles.has(resolved) || !fs.existsSync(resolved)) {
      return exportsMap;
    }

    this.loadingFiles.add(resolved);
    try {
      const code = fs.readFileSync(resolved, 'utf8');
      const sf = ts.createSourceFile(
        resolved,
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const env = createEnv();
      this.populateImports(sf, resolved, env);

      for (const stmt of sf.statements) {
        if (ts.isVariableStatement(stmt)) {
          const isExported = Boolean(
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          );
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer) {
              const val = this.evalStaticExpression(decl.initializer, env);
              if (val) {
                env.vars.set(decl.name.text, val);
                if (isExported) {
                  exportsMap.set(decl.name.text, val);
                }
              }
            }
          }
        } else if (ts.isEnumDeclaration(stmt)) {
          const isExported = Boolean(
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          );
          const enumMap = new Map<string, AstValue>();
          let autoVal = 0;
          for (const member of stmt.members) {
            const memberName =
              ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
                ? member.name.text
                : undefined;
            if (!memberName) {
              continue;
            }
            if (member.initializer) {
              const initVal = this.evalStaticExpression(member.initializer, env);
              if (initVal && initVal.kind === 'primitive') {
                enumMap.set(memberName, initVal);
                if (typeof initVal.value === 'number') {
                  autoVal = initVal.value + 1;
                }
              }
            } else {
              enumMap.set(memberName, { kind: 'primitive', value: autoVal++ });
            }
          }
          const enumObj: AstValue = { kind: 'object', properties: enumMap };
          env.vars.set(stmt.name.text, enumObj);
          if (isExported) {
            exportsMap.set(stmt.name.text, enumObj);
          }
        } else if (ts.isClassDeclaration(stmt) && stmt.name) {
          const isExported = Boolean(
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          );
          const isDefault = Boolean(
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
          );
          if (isExported || isDefault) {
            try {
              const subAnalyzer = new FileLocatorAnalyzer(
                resolved,
                code,
                this.visitedClassFiles,
                this
              );
              const classInst = subAnalyzer.getClassInstanceByName(stmt.name.text) ||
                subAnalyzer.getPrimaryClassInstance();
              if (classInst) {
                env.vars.set(stmt.name.text, classInst);
                if (isExported) {
                  exportsMap.set(stmt.name.text, classInst);
                }
                if (isDefault) {
                  exportsMap.set('default', classInst);
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    } finally {
      this.loadingFiles.delete(resolved);
    }

    this.moduleExportCache.set(resolved, exportsMap);
    return exportsMap;
  }

  public populateImports(sf: ts.SourceFile, filePath: string, env: ScopeEnv): void {
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
        continue;
      }
      if (!stmt.importClause || stmt.importClause.isTypeOnly) {
        continue;
      }
      const { name, namedBindings } = stmt.importClause;
      if (
        !name &&
        namedBindings &&
        ts.isNamedImports(namedBindings) &&
        namedBindings.elements.every(
          (el) => el.isTypeOnly || IGNORED_IMPORT_SYMBOLS.has(el.name.text)
        )
      ) {
        continue;
      }
      const spec = stmt.moduleSpecifier.text;
      const targetFile = resolveImportFilePath(filePath, spec);
      if (!targetFile) {
        continue;
      }
      const moduleExports = this.getModuleExports(targetFile);
      if (name) {
        const defaultExport = moduleExports.get('default');
        if (defaultExport) {
          env.vars.set(name.text, defaultExport);
        }
      }
      if (namedBindings) {
        if (ts.isNamedImports(namedBindings)) {
          for (const el of namedBindings.elements) {
            const importedName = el.propertyName ? el.propertyName.text : el.name.text;
            const localName = el.name.text;
            const val = moduleExports.get(importedName);
            if (val) {
              env.vars.set(localName, val);
            }
          }
        } else if (ts.isNamespaceImport(namedBindings)) {
          env.vars.set(namedBindings.name.text, {
            kind: 'object',
            properties: new Map(moduleExports),
          });
        }
      }
    }
  }

  public evalStaticExpression(node: ts.Node | undefined, env: ScopeEnv): AstValue | undefined {
    if (!node) {
      return undefined;
    }
    const target = unwrapParensAndTypes(node);

    if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) {
      return { kind: 'primitive', value: target.text };
    }
    if (ts.isNumericLiteral(target)) {
      return { kind: 'primitive', value: Number(target.text) };
    }
    if (target.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: 'primitive', value: true };
    }
    if (target.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: 'primitive', value: false };
    }
    if (target.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: 'primitive', value: null };
    }
    if (ts.isRegularExpressionLiteral(target)) {
      const text = target.text;
      const lastSlash = text.lastIndexOf('/');
      const source = text.slice(1, lastSlash);
      const flags = text.slice(lastSlash + 1);
      return { kind: 'regexp', source, flags };
    }
    if (ts.isTemplateExpression(target)) {
      let str = target.head.text;
      for (const span of target.templateSpans) {
        const inner = this.evalStaticExpression(span.expression, env);
        if (!inner || inner.kind !== 'primitive') {
          return undefined;
        }
        str += String(inner.value ?? '') + span.literal.text;
      }
      return { kind: 'primitive', value: str };
    }
    if (ts.isConditionalExpression(target)) {
      const cond = this.evalStaticExpression(target.condition, env);
      const isTruthy =
        cond?.kind === 'primitive' ? Boolean(cond.value) : Boolean(cond);
      return isTruthy
        ? this.evalStaticExpression(target.whenTrue, env)
        : this.evalStaticExpression(target.whenFalse, env);
    }
    if (ts.isPrefixUnaryExpression(target)) {
      const operand = this.evalStaticExpression(target.operand, env);
      if (operand && operand.kind === 'primitive') {
        if (
          target.operator === ts.SyntaxKind.MinusToken &&
          typeof operand.value === 'number'
        ) {
          return { kind: 'primitive', value: -operand.value };
        }
        if (target.operator === ts.SyntaxKind.ExclamationToken) {
          return { kind: 'primitive', value: !operand.value };
        }
      }
      return undefined;
    }
    if (ts.isBinaryExpression(target)) {
      const op = target.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken) {
        const left = this.evalStaticExpression(target.left, env);
        if (
          left &&
          !(
            left.kind === 'primitive' &&
            (left.value === null || left.value === undefined)
          )
        ) {
          return left;
        }
        return this.evalStaticExpression(target.right, env);
      }
      if (op === ts.SyntaxKind.BarBarToken) {
        const left = this.evalStaticExpression(target.left, env);
        const isTruthy =
          left?.kind === 'primitive' ? Boolean(left.value) : Boolean(left);
        if (isTruthy) {
          return left;
        }
        return this.evalStaticExpression(target.right, env);
      }
      const left = this.evalStaticExpression(target.left, env);
      const right = this.evalStaticExpression(target.right, env);
      if (
        op === ts.SyntaxKind.PlusToken &&
        left?.kind === 'primitive' &&
        right?.kind === 'primitive'
      ) {
        if (typeof left.value === 'string' || typeof right.value === 'string') {
          return {
            kind: 'primitive',
            value: String(left.value ?? '') + String(right.value ?? ''),
          };
        }
        if (typeof left.value === 'number' && typeof right.value === 'number') {
          return { kind: 'primitive', value: left.value + right.value };
        }
      }
      return undefined;
    }
    if (ts.isIdentifier(target)) {
      if (target.text === 'undefined') {
        return { kind: 'primitive', value: undefined };
      }
      return lookupEnv(env, target.text);
    }
    if (ts.isPropertyAccessExpression(target)) {
      const base = this.evalStaticExpression(target.expression, env);
      const propName = target.name.text;
      if (base?.kind === 'object') {
        return base.properties.get(propName);
      }
      if (base?.kind === 'classInstance') {
        return base.props.get(propName);
      }
      return undefined;
    }
    if (ts.isElementAccessExpression(target)) {
      const base = this.evalStaticExpression(target.expression, env);
      const idx = this.evalStaticExpression(target.argumentExpression, env);
      if (idx?.kind === 'primitive') {
        if (base?.kind === 'array' && typeof idx.value === 'number') {
          return base.elements[idx.value];
        }
        if (base?.kind === 'object' && typeof idx.value === 'string') {
          return base.properties.get(idx.value);
        }
      }
      return undefined;
    }
    if (ts.isArrayLiteralExpression(target)) {
      const elements: AstValue[] = [];
      for (const el of target.elements) {
        if (ts.isSpreadElement(el)) {
          const spreadVal = this.evalStaticExpression(el.expression, env);
          if (spreadVal?.kind === 'array') {
            elements.push(...spreadVal.elements);
          }
        } else {
          const v = this.evalStaticExpression(el, env);
          if (v) {
            elements.push(v);
          }
        }
      }
      return { kind: 'array', elements };
    }
    if (ts.isObjectLiteralExpression(target)) {
      const properties = new Map<string, AstValue>();
      for (const prop of target.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const key = getPropertyNameText(prop.name, env, this);
          const val = this.evalStaticExpression(prop.initializer, env);
          if (key && val) {
            properties.set(key, val);
          }
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const key = prop.name.text;
          const val = lookupEnv(env, key);
          if (val) {
            properties.set(key, val);
          }
        } else if (ts.isSpreadAssignment(prop)) {
          const spreadObj = this.evalStaticExpression(prop.expression, env);
          if (spreadObj?.kind === 'object') {
            for (const [k, v] of spreadObj.properties.entries()) {
              properties.set(k, v);
            }
          }
        }
      }
      return { kind: 'object', properties };
    }
    return undefined;
  }
}

function getPropertyNameText(
  nameNode: ts.PropertyName,
  env: ScopeEnv,
  loader: ModuleAstLoader
): string | undefined {
  if (
    ts.isIdentifier(nameNode) ||
    ts.isStringLiteral(nameNode) ||
    ts.isNumericLiteral(nameNode)
  ) {
    return nameNode.text;
  }
  if (ts.isComputedPropertyName(nameNode)) {
    const val = loader.evalStaticExpression(nameNode.expression, env);
    if (val?.kind === 'primitive' && val.value !== undefined && val.value !== null) {
      return String(val.value);
    }
  }
  return undefined;
}

/**
 * Находит корневую директорию проекта (по playwright.config.ts или package.json).
 */
function findProjectRootFromFile(startFile: string): string {
  let curDir = fs.existsSync(startFile) && fs.statSync(startFile).isDirectory()
    ? path.resolve(startFile)
    : path.dirname(path.resolve(startFile));
  let projectRoot = curDir;
  while (true) {
    if (
      fs.existsSync(path.join(curDir, 'playwright.config.ts')) ||
      fs.existsSync(path.join(curDir, 'package.json'))
    ) {
      projectRoot = curDir;
      break;
    }
    const parent = path.dirname(curDir);
    if (parent === curDir) {
      break;
    }
    curDir = parent;
  }
  return projectRoot;
}

/**
 * Основной анализатор файла, который выполняет символическую интерпретацию класса Page Object,
 * конструктора, локальных хелперов и методов.
 */
function findClassFileInProject(startFile: string, className: string): string | undefined {
  const projectRoot = findProjectRootFromFile(startFile);
  const targetFileName = `${className}.ts`;
  const searchRoots = [
    path.join(projectRoot, 'src', 'pages'),
    path.join(projectRoot, 'src', 'components'),
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'pages'),
  ];

  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > 5 || !fs.existsSync(dir)) {
      return undefined;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === targetFileName) {
        return full;
      }
      if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        !entry.name.startsWith('.')
      ) {
        const sub = walk(full, depth + 1);
        if (sub) {
          return sub;
        }
      }
    }
    return undefined;
  };

  for (const root of searchRoots) {
    const found = walk(root, 0);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function escapeRegExpForScan(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Находит файлы в проекте, содержащие подклассы `extends <baseClassName>`.
 */
function findSubclassFilesInProject(
  startFile: string,
  baseClassName: string
): string[] {
  const projectRoot = findProjectRootFromFile(startFile);
  const searchRoots = [
    path.join(projectRoot, 'src', 'pages'),
    path.join(projectRoot, 'src', 'components'),
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'pages'),
    path.dirname(path.resolve(startFile)),
  ];
  const extendsRegex = new RegExp(`\\bextends\\s+${escapeRegExpForScan(baseClassName)}\\b`);
  const visitedDirs = new Set<string>();
  const visitedFiles = new Set<string>();
  const matches: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || matches.length >= 20) {
      return;
    }
    const resolvedDir = path.resolve(dir);
    if (visitedDirs.has(resolvedDir) || !fs.existsSync(resolvedDir)) {
      return;
    }
    visitedDirs.add(resolvedDir);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= 20) {
        return;
      }
      const full = path.join(resolvedDir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name !== 'node_modules' &&
          entry.name !== 'dist' &&
          entry.name !== 'build' &&
          !entry.name.startsWith('.')
        ) {
          walk(full, depth + 1);
        }
        continue;
      }
      if (
        !entry.isFile() ||
        entry.name.endsWith('.d.ts') ||
        !/\.(ts|tsx|js|jsx)$/.test(entry.name)
      ) {
        continue;
      }
      if (visitedFiles.has(full)) {
        continue;
      }
      visitedFiles.add(full);
      try {
        const stat = fs.statSync(full);
        if (stat.size > 512 * 1024) {
          continue;
        }
        const content = fs.readFileSync(full, 'utf8');
        if (extendsRegex.test(content)) {
          matches.push(full);
        }
      } catch {
        // ignore unreadable files
      }
    }
  };

  for (const root of searchRoots) {
    walk(root, 0);
  }
  return matches;
}

/**
 * Находит файл констант в проекте по имени идентификатора (например, BaseConstant -> Base.constant.ts).
 */
function findConstantFileInProject(startFile: string, symbolName: string): string | undefined {
  const projectRoot = findProjectRootFromFile(startFile);
  const candidateNames = new Set<string>([`${symbolName}.ts`]);
  if (symbolName.endsWith('Constant')) {
    const base = symbolName.slice(0, -'Constant'.length);
    if (base) {
      candidateNames.add(`${base}.constant.ts`);
      candidateNames.add(`${base}Constant.ts`);
    }
  } else if (symbolName.endsWith('Constants')) {
    const base = symbolName.slice(0, -'Constants'.length);
    if (base) {
      candidateNames.add(`${base}.constant.ts`);
      candidateNames.add(`${base}.constants.ts`);
    }
  }

  const searchRoots = [
    path.join(projectRoot, 'src', 'dataConstant'),
    path.join(projectRoot, 'src', 'constants'),
    path.join(projectRoot, 'src'),
  ];

  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > 5 || !fs.existsSync(dir)) {
      return undefined;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && candidateNames.has(entry.name)) {
        return full;
      }
      if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        !entry.name.startsWith('.')
      ) {
        const sub = walk(full, depth + 1);
        if (sub) {
          return sub;
        }
      }
    }
    return undefined;
  };

  for (const root of searchRoots) {
    const found = walk(root, 0);
    if (found) {
      return found;
    }
  }
  return undefined;
}

interface SubclassInstanceVariant {
  className: string;
  instance: AstValue & { kind: 'classInstance' };
  ctorEnv?: ScopeEnv;
  nodeEnvs: Map<ts.Node, ScopeEnv>;
}

class FileLocatorAnalyzer {
  private readonly sf: ts.SourceFile;
  private readonly filePath: string;
  private readonly loader: ModuleAstLoader;
  private readonly rootEnv = createEnv();
  private readonly functionCalls = new Map<ts.Node, FunctionCallRecord[]>();
  private readonly classInstances = new Map<ts.ClassDeclaration, AstValue & { kind: 'classInstance' }>();
  private readonly nodeEnvs = new Map<ts.Node, ScopeEnv>();
  private readonly subclassVariantsCache = new Map<ts.ClassDeclaration, SubclassInstanceVariant[]>();
  private readonly visitedClassFiles: Set<string>;

  constructor(
    filePath: string,
    sourceText: string,
    visitedClassFiles?: Set<string>,
    sharedLoader?: ModuleAstLoader
  ) {
    this.filePath = path.resolve(filePath);
    this.loader = sharedLoader || new ModuleAstLoader();
    this.visitedClassFiles = visitedClassFiles || this.loader.visitedClassFiles;
    this.visitedClassFiles.add(this.filePath);
    this.sf = ts.createSourceFile(
      this.filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    this.initializeFileScope();
  }

  public getSourceFile(): ts.SourceFile {
    return this.sf;
  }

  public getPrimaryClassInstance(): (AstValue & { kind: 'classInstance' }) | undefined {
    for (const inst of this.classInstances.values()) {
      return inst;
    }
    return undefined;
  }

  public getPrimaryClassDeclaration(): ts.ClassDeclaration | undefined {
    for (const decl of this.classInstances.keys()) {
      return decl;
    }
    return undefined;
  }

  public findEnclosingClassDeclaration(node: ts.Node): ts.ClassDeclaration | undefined {
    let cur: ts.Node | undefined = node;
    while (cur) {
      if (ts.isClassDeclaration(cur) && this.classInstances.has(cur)) {
        return cur;
      }
      cur = cur.parent;
    }
    return undefined;
  }

  public collectSuperCallsForBaseClass(
    baseClassName: string
  ): Array<{ className: string; superArgs: Array<AstValue | undefined> }> {
    const results: Array<{ className: string; superArgs: Array<AstValue | undefined> }> = [];
    for (const stmt of this.sf.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name || !stmt.heritageClauses) {
        continue;
      }
      const extendsBase = stmt.heritageClauses.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some((heritageType) => {
            const expr = unwrapParensAndTypes(heritageType.expression);
            return ts.isIdentifier(expr) && expr.text === baseClassName;
          })
      );
      if (!extendsBase) {
        continue;
      }
      const subCtor = stmt.members.find(
        (m): m is ts.ConstructorDeclaration =>
          ts.isConstructorDeclaration(m) && Boolean(m.body)
      );
      if (!subCtor || !subCtor.body) {
        continue;
      }
      const subCtorEnv =
        this.nodeEnvs.get(subCtor) || this.classInstances.get(stmt)?.ctorEnv;
      if (!subCtorEnv) {
        continue;
      }
      let superCall: ts.CallExpression | undefined;
      const findSuper = (n: ts.Node): void => {
        if (superCall) {
          return;
        }
        if (
          ts.isCallExpression(n) &&
          n.expression.kind === ts.SyntaxKind.SuperKeyword
        ) {
          superCall = n;
          return;
        }
        if (
          ts.isFunctionDeclaration(n) ||
          ts.isFunctionExpression(n) ||
          ts.isArrowFunction(n) ||
          ts.isClassExpression(n)
        ) {
          return;
        }
        ts.forEachChild(n, findSuper);
      };
      findSuper(subCtor.body);
      if (!superCall) {
        continue;
      }
      const superArgs = superCall.arguments.map((arg) =>
        this.evaluateNode(arg, subCtorEnv, new Set())
      );
      results.push({
        className: stmt.name.text,
        superArgs,
      });
    }
    return results;
  }

  private buildClassInstanceWithCtorArgs(
    classDecl: ts.ClassDeclaration,
    ctorArgOverrides: Array<AstValue | undefined>
  ): SubclassInstanceVariant {
    const className = classDecl.name?.text || 'AnonymousClass';
    const classEnv = createEnv(this.rootEnv);
    const props = new Map<string, AstValue>();
    const methods = new Map<string, ts.MethodDeclaration>();
    const variantNodeEnvs = new Map<ts.Node, ScopeEnv>();

    props.set('page', { kind: 'page' });

    const instance: AstValue & { kind: 'classInstance' } = {
      kind: 'classInstance',
      className,
      props,
      methods,
      classEnv,
    };

    classEnv.vars.set('this', instance);

    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member) && member.name) {
        const mName =
          ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
            ? member.name.text
            : undefined;
        if (mName) {
          methods.set(mName, member);
        }
      }
    }

    for (const member of classDecl.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        const pName =
          ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
            ? member.name.text
            : undefined;
        variantNodeEnvs.set(member, classEnv);
        if (pName) {
          const val = this.evaluateNode(member.initializer, classEnv, new Set());
          if (val) {
            props.set(pName, val);
          }
        }
      }
    }

    let ctorEnvResult: ScopeEnv | undefined;
    for (const member of classDecl.members) {
      if (ts.isConstructorDeclaration(member) && member.body) {
        const ctorEnv = createEnv(classEnv);
        ctorEnv.vars.set('this', instance);
        member.parameters.forEach((param, idx) => {
          if (ts.isIdentifier(param.name)) {
            const overrideVal = ctorArgOverrides[idx];
            if (overrideVal !== undefined) {
              ctorEnv.vars.set(param.name.text, overrideVal);
            } else if (param.name.text === 'page') {
              ctorEnv.vars.set('page', { kind: 'page' });
            } else if (param.initializer) {
              const defVal = this.evaluateNode(param.initializer, ctorEnv, new Set());
              if (defVal) {
                ctorEnv.vars.set(param.name.text, defVal);
              }
            } else {
              const isBooleanParam =
                param.type?.kind === ts.SyntaxKind.BooleanKeyword ||
                /^is[A-Z]/.test(param.name.text);
              ctorEnv.vars.set(param.name.text, {
                kind: 'primitive',
                value: isBooleanParam ? false : undefined,
              });
            }
          }
        });
        variantNodeEnvs.set(member, ctorEnv);
        this.executeStatementBlock(
          member.body.statements,
          ctorEnv,
          instance,
          variantNodeEnvs
        );
        ctorEnvResult = cloneEnv(ctorEnv);
        instance.ctorEnv = ctorEnvResult;
      }
    }

    return {
      className,
      instance,
      ctorEnv: ctorEnvResult,
      nodeEnvs: variantNodeEnvs,
    };
  }

  private getSubclassVariantsForClass(
    classDecl: ts.ClassDeclaration
  ): SubclassInstanceVariant[] {
    const cached = this.subclassVariantsCache.get(classDecl);
    if (cached) {
      return cached;
    }
    const baseClassName = classDecl.name?.text;
    const baseCtor = classDecl.members.find(
      (m): m is ts.ConstructorDeclaration =>
        ts.isConstructorDeclaration(m) && Boolean(m.body)
    );
    if (!baseClassName || !baseCtor || baseCtor.parameters.length <= 1) {
      this.subclassVariantsCache.set(classDecl, []);
      return [];
    }

    const superCalls: Array<{
      className: string;
      superArgs: Array<AstValue | undefined>;
    }> = [...this.collectSuperCallsForBaseClass(baseClassName)];

    const candidateFiles = findSubclassFilesInProject(
      this.filePath,
      baseClassName
    );
    for (const subFile of candidateFiles) {
      const resolvedSub = path.resolve(subFile);
      if (resolvedSub === this.filePath || this.visitedClassFiles.has(resolvedSub)) {
        continue;
      }
      try {
        const subText = fs.readFileSync(resolvedSub, 'utf8');
        const subAnalyzer = new FileLocatorAnalyzer(
          resolvedSub,
          subText,
          new Set(this.visitedClassFiles),
          this.loader
        );
        superCalls.push(...subAnalyzer.collectSuperCallsForBaseClass(baseClassName));
      } catch {
        // ignore unparseable subclass files
      }
    }

    const variants: SubclassInstanceVariant[] = [];
    for (const call of superCalls) {
      if (call.superArgs.length <= 1) {
        continue;
      }
      const built = this.buildClassInstanceWithCtorArgs(classDecl, call.superArgs);
      variants.push({
        ...built,
        className: call.className,
      });
    }

    this.subclassVariantsCache.set(classDecl, variants);
    return variants;
  }

  public buildSubclassLocatorVariants(
    locatorExprNode: ts.Node,
    baseDescriptor: LocatorDescriptor,
    baseScope: ScopeEnv,
    explicitClassDecl?: ts.ClassDeclaration
  ): LocatorVariant[] {
    const classDecl =
      explicitClassDecl || this.findEnclosingClassDeclaration(locatorExprNode);
    if (!classDecl) {
      return [];
    }
    const subVariants = this.getSubclassVariantsForClass(classDecl);
    if (subVariants.length === 0) {
      return [];
    }
    const baseClassName = classDecl.name?.text || 'Default';
    const seenHuman = new Set<string>([baseDescriptor.humanReadable]);
    const extraVariants: LocatorVariant[] = [];

    for (const sv of subVariants) {
      let variantScope: ScopeEnv | undefined;
      let cur: ts.Node | undefined = locatorExprNode;
      while (cur) {
        const found = sv.nodeEnvs.get(cur);
        if (found) {
          variantScope = cloneEnv(found);
          break;
        }
        cur = cur.parent;
      }
      if (!variantScope) {
        variantScope = cloneEnv(baseScope);
      }
      variantScope.vars.set('this', sv.instance);

      const vEval = this.evaluateNode(locatorExprNode, variantScope, new Set());
      if (vEval?.kind === 'locator' && !seenHuman.has(vEval.descriptor.humanReadable)) {
        seenHuman.add(vEval.descriptor.humanReadable);
        extraVariants.push({
          id: sv.className,
          label: sv.className,
          description: vEval.descriptor.humanReadable,
          parameters: {},
          descriptor: vEval.descriptor,
        });
      }
    }

    if (extraVariants.length === 0) {
      return [];
    }

    return [
      {
        id: baseClassName,
        label: `${baseClassName} (default)`,
        description: baseDescriptor.humanReadable,
        parameters: {},
        descriptor: baseDescriptor,
      },
      ...extraVariants,
    ];
  }

  public getClassInstanceByName(
    name: string
  ): (AstValue & { kind: 'classInstance' }) | undefined {
    for (const [decl, inst] of this.classInstances.entries()) {
      if (decl.name?.text === name) {
        return inst;
      }
    }
    return undefined;
  }

  private initializeFileScope(): void {
    this.rootEnv.vars.set('page', { kind: 'page' });
    this.loader.populateImports(this.sf, this.filePath, this.rootEnv);

    for (const stmt of this.sf.statements) {
      this.nodeEnvs.set(stmt, this.rootEnv);
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const val = this.evaluateNode(decl.initializer, this.rootEnv, new Set());
            if (val) {
              this.rootEnv.vars.set(decl.name.text, val);
            }
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        this.rootEnv.vars.set(stmt.name.text, {
          kind: 'function',
          name: stmt.name.text,
          node: stmt,
          env: cloneEnv(this.rootEnv),
        });
      } else if (ts.isClassDeclaration(stmt)) {
        this.analyzeClassDeclaration(stmt);
      }
    }
  }

  private analyzeClassDeclaration(classDecl: ts.ClassDeclaration): void {
    const className = classDecl.name?.text || 'AnonymousPage';
    const classEnv = createEnv(this.rootEnv);
    const props = new Map<string, AstValue>();
    const methods = new Map<string, ts.MethodDeclaration>();

    props.set('page', { kind: 'page' });

    const instance: AstValue & { kind: 'classInstance' } = {
      kind: 'classInstance',
      className,
      props,
      methods,
      classEnv,
    };

    classEnv.vars.set('this', instance);
    this.classInstances.set(classDecl, instance);

    // 1. Сначала регистрируем методы и инициализаторы полей класса
    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member) && member.name) {
        const mName =
          ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
            ? member.name.text
            : undefined;
        if (mName) {
          methods.set(mName, member);
        }
      }
    }

    for (const member of classDecl.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        const pName =
          ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
            ? member.name.text
            : undefined;
        this.nodeEnvs.set(member, classEnv);
        if (pName) {
          const val = this.evaluateNode(member.initializer, classEnv, new Set());
          if (val) {
            props.set(pName, val);
          }
        }
      }
    }

    // 2. Интерпретируем конструктор сверху вниз
    for (const member of classDecl.members) {
      if (ts.isConstructorDeclaration(member) && member.body) {
        const ctorEnv = createEnv(classEnv);
        ctorEnv.vars.set('this', instance);
        for (const param of member.parameters) {
          if (ts.isIdentifier(param.name)) {
            if (param.name.text === 'page') {
              ctorEnv.vars.set('page', { kind: 'page' });
            } else if (param.initializer) {
              const defVal = this.evaluateNode(param.initializer, ctorEnv, new Set());
              if (defVal) {
                ctorEnv.vars.set(param.name.text, defVal);
              }
            } else {
              // Для boolean-параметров (например, isMobile?: boolean) задаём false,
              // для остальных опциональных (options?, root?) — undefined, чтобы срабатывал `??`
              const isBooleanParam =
                param.type?.kind === ts.SyntaxKind.BooleanKeyword ||
                /^is[A-Z]/.test(param.name.text);
              ctorEnv.vars.set(param.name.text, {
                kind: 'primitive',
                value: isBooleanParam ? false : undefined,
              });
            }
          }
        }
        this.nodeEnvs.set(member, ctorEnv);
        this.executeStatementBlock(member.body.statements, ctorEnv, instance);
        instance.ctorEnv = cloneEnv(ctorEnv);
      }
    }

    // 3. Сохраняем окружения для всех остальных методов и собираем вызовы параметризованных методов
    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member) && member.body) {
        const methodEnv = createEnv(classEnv);
        methodEnv.vars.set('this', instance);
        for (const param of member.parameters) {
          if (ts.isIdentifier(param.name)) {
            methodEnv.vars.set(param.name.text, {
              kind: 'unresolvedParam',
              paramName: param.name.text,
            });
          }
        }
        this.nodeEnvs.set(member, methodEnv);
        this.scanMethodForCallsAndVars(member.body, methodEnv, instance);
      }
    }
  }

  private executeStatementBlock(
    statements: readonly ts.Statement[],
    env: ScopeEnv,
    instance: AstValue & { kind: 'classInstance' },
    targetNodeEnvs: Map<ts.Node, ScopeEnv> = this.nodeEnvs
  ): void {
    for (const stmt of statements) {
      targetNodeEnvs.set(stmt, cloneEnv(env));

      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          targetNodeEnvs.set(decl, cloneEnv(env));
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const varName = decl.name.text;
            const val = this.evaluateNode(
              decl.initializer,
              env,
              new Set(),
              varName
            );
            if (val) {
              env.vars.set(varName, val);
            }
          }
        }
      } else if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const bin = stmt.expression;
        const left = unwrapParensAndTypes(bin.left);
        if (
          ts.isPropertyAccessExpression(left) &&
          left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const propName = left.name.text;
          const val = this.evaluateNode(
            bin.right,
            env,
            new Set(),
            `this.${propName}`
          );
          if (val) {
            instance.props.set(propName, val);
          }
        }
      }
    }
  }

  private scanMethodForCallsAndVars(
    node: ts.Node,
    env: ScopeEnv,
    instance: AstValue & { kind: 'classInstance' }
  ): void {
    this.nodeEnvs.set(node, env);

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const val = this.evaluateNode(decl.initializer, env, new Set(), decl.name.text);
          if (val) {
            env.vars.set(decl.name.text, val);
          }
        }
      }
    } else if (ts.isForOfStatement(node)) {
      const iterableVal = this.evaluateNode(node.expression, env, new Set());
      if (
        iterableVal?.kind === 'array' &&
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.declarations.length === 1
      ) {
        const loopVarDecl = node.initializer.declarations[0];
        if (ts.isIdentifier(loopVarDecl.name)) {
          const loopVarName = loopVarDecl.name.text;
          for (const itemVal of iterableVal.elements) {
            const iterEnv = createEnv(env);
            iterEnv.vars.set(loopVarName, itemVal);
            this.scanMethodForCallsAndVars(node.statement, iterEnv, instance);
          }
          return;
        }
      }
    } else if (ts.isCallExpression(node)) {
      // Проверяем вызов this.<method>(...)
      const callee = unwrapParensAndTypes(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const methodName = callee.name.text;
        const methodDecl = instance.methods.get(methodName);
        if (methodDecl) {
          this.recordMethodOrFunctionCall(
            methodDecl,
            node.arguments,
            env,
            `this.${methodName}`
          );
        }
      }
    }

    ts.forEachChild(node, (child) => this.scanMethodForCallsAndVars(child, env, instance));
  }

  private recordMethodOrFunctionCall(
    fnNode:
      | ts.ArrowFunction
      | ts.FunctionExpression
      | ts.FunctionDeclaration
      | ts.MethodDeclaration,
    callArgs: readonly ts.Expression[],
    callerEnv: ScopeEnv,
    callerLabelPrefix: string
  ): void {
    const argsByName: Record<string, AstValue> = {};
    let hasUnresolved = false;
    const summaryParts: string[] = [];

    fnNode.parameters.forEach((param, idx) => {
      if (!ts.isIdentifier(param.name)) {
        return;
      }
      const pName = param.name.text;
      const argNode = callArgs[idx];
      const argVal = argNode
        ? this.evaluateNode(argNode, callerEnv, new Set())
        : param.initializer
          ? this.evaluateNode(param.initializer, callerEnv, new Set())
          : undefined;
      if (!argVal || argVal.kind === 'unresolvedParam') {
        hasUnresolved = true;
      } else {
        argsByName[pName] = argVal;
        if (argVal.kind === 'primitive') {
          summaryParts.push(`${pName}: ${JSON.stringify(argVal.value)}`);
        }
      }
    });

    if (hasUnresolved || Object.keys(argsByName).length === 0) {
      return;
    }

    const list = this.functionCalls.get(fnNode) || [];
    const summary = summaryParts.join(', ');
    const callerName = callerLabelPrefix
      ? `${callerLabelPrefix} (${summary})`
      : summary;

    // Избегаем дубликатов с одинаковыми значениями аргументов
    if (!list.some((item) => item.callerName.endsWith(`(${summary})`) || item.callerName === summary)) {
      list.push({
        callerName,
        description: callerLabelPrefix,
        argsByName,
      });
      this.functionCalls.set(fnNode, list);
    }
  }

  /**
   * Вычисляет AST-узел в AstValue (включая цепочки Playwright Locator).
   */
  public evaluateNode(
    rawNode: ts.Node | undefined,
    env: ScopeEnv,
    unresolvedParams: Set<string>,
    contextLabel?: string
  ): AstValue | undefined {
    if (!rawNode) {
      return undefined;
    }
    const node = unwrapParensAndTypes(rawNode);

    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      return lookupEnv(env, 'this');
    }

    if (ts.isIdentifier(node)) {
      if (node.text === 'page') {
        return lookupEnv(env, 'page') || { kind: 'page' };
      }
      const existing = lookupEnv(env, node.text);
      if (existing) {
        return existing;
      }
      // Если это константа проекта (например, BaseConstant, SettingsPageConstant, HomePageConstant)
      if (/^[A-Za-z_$][\w]*Constants?$/.test(node.text)) {
        const constFile = findConstantFileInProject(this.filePath, node.text);
        if (constFile) {
          const exportsMap = this.loader.getModuleExports(constFile);
          const constVal = exportsMap.get(node.text) || exportsMap.get('default');
          if (constVal) {
            this.rootEnv.vars.set(node.text, constVal);
            return constVal;
          }
        }
      }
      // Если это фикстура Page Object или Component в тесте (например, settingsPage)
      if (
        /^[a-z][\w]*(Page|Component|Modal|Section|Form)$/.test(node.text)
      ) {
        const className = node.text.charAt(0).toUpperCase() + node.text.slice(1);
        const classFile = findClassFileInProject(this.filePath, className);
        if (classFile && !this.visitedClassFiles.has(path.resolve(classFile))) {
          try {
            const subAnalyzer = new FileLocatorAnalyzer(
              classFile,
              fs.readFileSync(classFile, 'utf8'),
              this.visitedClassFiles,
              this.loader
            );
            const inst = subAnalyzer.getPrimaryClassInstance();
            if (inst) {
              this.rootEnv.vars.set(node.text, inst);
              return inst;
            }
          } catch {
            // ignore
          }
        }
      }
      return undefined;
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) {
        return this.evaluateNode(node.right, env, unresolvedParams, contextLabel);
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken) {
        const leftUnresolved =
          unresolvedParams instanceof LoopEvaluation
            ? new LoopEvaluation()
            : new Set<string>();
        const left = this.evaluateNode(node.left, env, leftUnresolved, contextLabel);
        const hasConcreteLeft =
          left !== undefined &&
          left.kind !== 'unresolvedParam' &&
          !(
            left.kind === 'primitive' &&
            (left.value === null || left.value === undefined)
          );
        if (hasConcreteLeft) {
          for (const p of leftUnresolved) {
            unresolvedParams.add(p);
          }
          return left;
        }
        return this.evaluateNode(node.right, env, unresolvedParams, contextLabel);
      }
      if (op === ts.SyntaxKind.BarBarToken) {
        const leftUnresolved =
          unresolvedParams instanceof LoopEvaluation
            ? new LoopEvaluation()
            : new Set<string>();
        const left = this.evaluateNode(node.left, env, leftUnresolved, contextLabel);
        const isTruthy =
          left !== undefined &&
          left.kind !== 'unresolvedParam' &&
          (left.kind === 'primitive' ? Boolean(left.value) : true);
        if (isTruthy) {
          for (const p of leftUnresolved) {
            unresolvedParams.add(p);
          }
          return left;
        }
        return this.evaluateNode(node.right, env, unresolvedParams, contextLabel);
      }
    }

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isPrefixUnaryExpression(node) ||
      ts.isBinaryExpression(node)
    ) {
      return this.loader.evalStaticExpression(node, env);
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return {
        kind: 'function',
        name: contextLabel || 'anonymous',
        node,
        env: cloneEnv(env),
      };
    }

    if (ts.isArrayLiteralExpression(node)) {
      const elements: AstValue[] = [];
      for (const el of node.elements) {
        const v = this.evaluateNode(el, env, unresolvedParams);
        if (v) {
          elements.push(v);
        }
      }
      return { kind: 'array', elements };
    }

    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map<string, AstValue>();
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const key = getPropertyNameText(prop.name, env, this.loader);
          if (key) {
            const subLabel = contextLabel ? `${contextLabel}.${key}` : key;
            const val = this.evaluateNode(
              prop.initializer,
              env,
              unresolvedParams,
              subLabel
            );
            if (val) {
              properties.set(key, val);
            } else if (unresolvedParams instanceof LoopEvaluation) {
              unresolvedParams.add(MISSING_LOOP_VALUE);
            }
          } else if (unresolvedParams instanceof LoopEvaluation) {
            unresolvedParams.add(MISSING_LOOP_VALUE);
          }
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const key = prop.name.text;
          const val = lookupEnv(env, key);
          if (val) {
            properties.set(key, val);
          } else if (unresolvedParams instanceof LoopEvaluation) {
            unresolvedParams.add(MISSING_LOOP_VALUE);
          }
        } else if (ts.isSpreadAssignment(prop)) {
          const spreadVal = this.evaluateNode(prop.expression, env, unresolvedParams);
          if (spreadVal?.kind === 'object') {
            for (const [k, v] of spreadVal.properties.entries()) {
              properties.set(k, v);
            }
          } else if (unresolvedParams instanceof LoopEvaluation) {
            unresolvedParams.add(MISSING_LOOP_VALUE);
          }
        } else if (unresolvedParams instanceof LoopEvaluation) {
          unresolvedParams.add(MISSING_LOOP_VALUE);
        }
      }
      return { kind: 'object', properties };
    }

    if (
      ts.isPropertyDeclaration(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      const classInst = this.getClassInstanceForNode(node);
      return classInst?.props.get(node.name.text);
    }

    if (ts.isPropertyAccessExpression(node)) {
      const base = this.evaluateNode(node.expression, env, unresolvedParams);
      const propName = node.name.text;
      if (base?.kind === 'array' && propName === 'length') {
        return { kind: 'primitive', value: base.elements.length };
      }
      if (
        base?.kind === 'locator' &&
        (propName === 'not' ||
          propName === 'soft' ||
          propName === 'resolves' ||
          propName === 'rejects')
      ) {
        return base;
      }
      if (base?.kind === 'object') {
        return base.properties.get(propName);
      }
      if (base?.kind === 'classInstance') {
        if (propName === 'page') {
          return { kind: 'page' };
        }
        return base.props.get(propName);
      }
      return undefined;
    }

    if (ts.isElementAccessExpression(node)) {
      const base = this.evaluateNode(node.expression, env, unresolvedParams);
      const idx = this.evaluateNode(node.argumentExpression, env, unresolvedParams);
      if (idx?.kind === 'primitive') {
        if (base?.kind === 'array' && typeof idx.value === 'number') {
          return base.elements[idx.value];
        }
        if (base?.kind === 'object' && typeof idx.value === 'string') {
          return base.properties.get(idx.value);
        }
      }
      return undefined;
    }

    if (ts.isConditionalExpression(node)) {
      const cond = this.evaluateNode(node.condition, env, unresolvedParams);
      const isTruthy =
        cond?.kind === 'primitive' ? Boolean(cond.value) : Boolean(cond);
      return isTruthy
        ? this.evaluateNode(node.whenTrue, env, unresolvedParams, contextLabel)
        : this.evaluateNode(node.whenFalse, env, unresolvedParams, contextLabel);
    }

    if (ts.isNewExpression(node)) {
      const targetExpr = unwrapParensAndTypes(node.expression);
      const existingVal = this.evaluateNode(targetExpr, env, unresolvedParams);
      if (existingVal?.kind === 'classInstance') {
        return existingVal;
      }
      if (ts.isIdentifier(targetExpr)) {
        const className = targetExpr.text;
        const classFile = findClassFileInProject(this.filePath, className);
        if (classFile && !this.visitedClassFiles.has(path.resolve(classFile))) {
          try {
            const subAnalyzer = new FileLocatorAnalyzer(
              classFile,
              fs.readFileSync(classFile, 'utf8'),
              this.visitedClassFiles,
              this.loader
            );
            const inst =
              subAnalyzer.getClassInstanceByName(className) ||
              subAnalyzer.getPrimaryClassInstance();
            if (inst) {
              return inst;
            }
          } catch {
            // ignore
          }
        }
      }
      return undefined;
    }

    if (ts.isCallExpression(node)) {
      return this.evaluateCallExpression(node, env, unresolvedParams, contextLabel);
    }

    return undefined;
  }

  private evaluateCallExpression(
    callNode: ts.CallExpression,
    env: ScopeEnv,
    unresolvedParams: Set<string>,
    contextLabel?: string
  ): AstValue | undefined {
    const callee = unwrapParensAndTypes(callNode.expression);

    // 1. Вызов expect(locator) / expect.soft(locator) / expect.poll(locator) -> возвращаем сам locator
    if (
      callNode.arguments.length > 0 &&
      ((ts.isIdentifier(callee) && callee.text === 'expect') ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'expect' &&
          (callee.name.text === 'soft' || callee.name.text === 'poll')))
    ) {
      return this.evaluateNode(callNode.arguments[0], env, unresolvedParams, contextLabel);
    }

    // 2. Вызов локальной функции-фабрики: fieldInputByLabel(...) или прямой вызов метода локатора без page. (getByTestId(...), locator(...))
    if (ts.isIdentifier(callee)) {
      const fnVal = lookupEnv(env, callee.text);
      if (fnVal?.kind === 'function') {
        this.recordMethodOrFunctionCall(
          fnVal.node,
          callNode.arguments,
          env,
          contextLabel || callee.text
        );
        return this.invokeAstFunction(
          fnVal.node,
          fnVal.env,
          callNode.arguments,
          env,
          unresolvedParams
        );
      }
      if (LOCATOR_ROOT_METHODS.has(callee.text)) {
        const serializedArgs = callNode.arguments.map((arg) => {
          const v = this.evaluateNode(arg, env, unresolvedParams);
          return astValueToSerializedArg(v, unresolvedParams);
        });
        while (
          serializedArgs.length > 0 &&
          serializedArgs[serializedArgs.length - 1] === undefined
        ) {
          serializedArgs.pop();
        }
        const steps: LocatorStep[] = [
          {
            method: callee.text as LocatorMethodName,
            args: serializedArgs,
          },
        ];
        return {
          kind: 'locator',
          descriptor: {
            steps,
            humanReadable: formatLocatorSteps(steps),
          },
        };
      }
    }

    // 3. Вызов метода на объекте: page.locator(...), locator.filter(...), this.getDeliverySwitch(...)
    if (ts.isPropertyAccessExpression(callee)) {
      const methodName = callee.name.text;

      // Если это терминальное действие (.click(), .fill(), .toBeVisible() и т.д.) —
      // возвращаем значение ресивера без выполнения действия!
      if (
        TERMINAL_ACTION_METHODS.has(methodName) ||
        methodName.startsWith('toBe') ||
        methodName.startsWith('toHave') ||
        methodName.startsWith('toContain')
      ) {
        return this.evaluateNode(callee.expression, env, unresolvedParams, contextLabel);
      }

      const receiver = this.evaluateNode(callee.expression, env, unresolvedParams);

      // Вызов метода на page / this.page
      if (receiver?.kind === 'page' && LOCATOR_ROOT_METHODS.has(methodName)) {
        const serializedArgs = callNode.arguments.map((arg) => {
          const v = this.evaluateNode(arg, env, unresolvedParams);
          return astValueToSerializedArg(v, unresolvedParams);
        });
        while (serializedArgs.length > 0 && serializedArgs[serializedArgs.length - 1] === undefined) {
          serializedArgs.pop();
        }
        const steps: LocatorStep[] = [
          {
            method: methodName as LocatorMethodName,
            args: serializedArgs,
          },
        ];
        return {
          kind: 'locator',
          descriptor: {
            steps,
            humanReadable: formatLocatorSteps(steps),
          },
        };
      }

      // Продолжение цепочки на существующем Locator
      if (receiver?.kind === 'locator' && LOCATOR_CHAIN_METHODS.has(methodName)) {
        const serializedArgs = callNode.arguments.map((arg) => {
          const v = this.evaluateNode(arg, env, unresolvedParams);
          return astValueToSerializedArg(v, unresolvedParams);
        });
        while (serializedArgs.length > 0 && serializedArgs[serializedArgs.length - 1] === undefined) {
          serializedArgs.pop();
        }
        const steps: LocatorStep[] = [
          ...receiver.descriptor.steps,
          {
            method: methodName as LocatorMethodName,
            args: serializedArgs,
          },
        ];
        return {
          kind: 'locator',
          descriptor: {
            steps,
            humanReadable: formatLocatorSteps(steps),
          },
        };
      }

      // Вызов собственного метода класса: this.getDeliverySwitch(...)
      if (receiver?.kind === 'classInstance') {
        const methodDecl = receiver.methods.get(methodName);
        if (methodDecl) {
          this.recordMethodOrFunctionCall(
            methodDecl,
            callNode.arguments,
            env,
            contextLabel || `this.${methodName}`
          );
          return this.invokeAstFunction(
            methodDecl,
            receiver.classEnv,
            callNode.arguments,
            env,
            unresolvedParams
          );
        }
      }
    }

    return undefined;
  }

  private invokeAstFunction(
    fnNode:
      | ts.ArrowFunction
      | ts.FunctionExpression
      | ts.FunctionDeclaration
      | ts.MethodDeclaration,
    declarationEnv: ScopeEnv,
    callArgs: readonly ts.Expression[],
    callerEnv: ScopeEnv,
    unresolvedParams: Set<string>
  ): AstValue | undefined {
    const callScope = createEnv(declarationEnv);
    fnNode.parameters.forEach((param, index) => {
      if (!ts.isIdentifier(param.name)) {
        return;
      }
      const paramName = param.name.text;
      const argExpr = callArgs[index];
      const argVal = argExpr
        ? this.evaluateNode(argExpr, callerEnv, unresolvedParams)
        : param.initializer
          ? this.evaluateNode(param.initializer, declarationEnv, unresolvedParams)
          : { kind: 'unresolvedParam' as const, paramName };
      callScope.vars.set(
        paramName,
        argVal || { kind: 'unresolvedParam', paramName }
      );
    });

    return this.evaluateFunctionBody(fnNode, callScope, unresolvedParams);
  }

  public evaluateFunctionBody(
    fnNode:
      | ts.ArrowFunction
      | ts.FunctionExpression
      | ts.FunctionDeclaration
      | ts.MethodDeclaration,
    fnScope: ScopeEnv,
    unresolvedParams: Set<string>
  ): AstValue | undefined {
    if (!fnNode.body) {
      return undefined;
    }
    if (!ts.isBlock(fnNode.body)) {
      return this.evaluateNode(fnNode.body, fnScope, unresolvedParams);
    }
    for (const stmt of fnNode.body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const val = this.evaluateNode(decl.initializer, fnScope, unresolvedParams);
            if (val) {
              fnScope.vars.set(decl.name.text, val);
            }
          }
        }
      } else if (ts.isReturnStatement(stmt) && stmt.expression) {
        return this.evaluateNode(stmt.expression, fnScope, unresolvedParams);
      }
    }
    return undefined;
  }

  /**
   * Находит ближайший ScopeEnv для произвольного AST-узла.
   */
  public findScopeForNode(node: ts.Node): ScopeEnv {
    let cur: ts.Node | undefined = node;
    while (cur) {
      const env = this.nodeEnvs.get(cur);
      if (env) {
        return cloneEnv(env);
      }
      cur = cur.parent;
    }
    return cloneEnv(this.rootEnv);
  }

  public resolveForLocator(node: ts.Node, overrides?: Record<string, SerializedArg>): LocatorDescriptor | undefined {
    if (ts.isIdentifier(node) && ts.isVariableDeclaration(node.parent) && node.parent.name === node && node.parent.initializer) {
      node = node.parent.initializer;
    }
    const pathToNode: ts.Node[] = [node];
    let outerLoop: ts.ForStatement | undefined;
    for (let child = node; child.parent; child = child.parent) {
      const parent = child.parent;
      if (ts.isFunctionLike(parent)) break;
      if (ts.isForStatement(parent) && parent.statement === child) outerLoop = parent;
      pathToNode.unshift(parent);
    }
    if (!outerLoop) return undefined;

    const outerIndex = pathToNode.indexOf(outerLoop);
    const scope = this.findScopeForNode(outerLoop);
    for (const [name, value] of Object.entries(overrides ?? {})) {
      scope.vars.set(name, serializedArgToAstValue(value));
    }
    let scopes = [scope];
    let remaining = MAX_STATIC_FOR_ITERATIONS;
    for (let p = Math.max(0, outerIndex - 1); p < pathToNode.length - 1; p++) {
      const parent = pathToNode[p];
      const child = pathToNode[p + 1];
      if (ts.isBlock(parent)) {
        scopes = scopes.map((env) => {
          const block = createEnv(env);
          for (const stmt of parent.statements) {
            if (stmt === child) break;
            if (!ts.isVariableStatement(stmt)) continue;
            for (const decl of stmt.declarationList.declarations) {
              if (!ts.isIdentifier(decl.name)) continue;
              const unresolved = new LoopEvaluation();
              const value = stmt.declarationList.flags & ts.NodeFlags.Const
                ? this.evaluateNode(decl.initializer, block, unresolved)
                : undefined;
              block.vars.set(decl.name.text, value && !unresolved.size ? value : { kind: 'unresolvedParam', paramName: decl.name.text });
            }
          }
          return block;
        });
      } else if (ts.isForStatement(parent) && parent.statement === child) {
        const init = parent.initializer;
        const decl = init && ts.isVariableDeclarationList(init) && init.declarations.length === 1 ? init.declarations[0] : undefined;
        const condition = parent.condition;
        const update = parent.incrementor;
        const invalid = () => new StaticForResolutionError('Cannot statically resolve the for loop. Expected an integer counter with a known bound and ++ or --.');
        if (!decl || !ts.isIdentifier(decl.name) || !condition || !ts.isBinaryExpression(condition) ||
            !ts.isIdentifier(condition.left) || condition.left.text !== decl.name.text ||
            !update || !(ts.isPrefixUnaryExpression(update) || ts.isPostfixUnaryExpression(update)) ||
            !ts.isIdentifier(update.operand) || update.operand.text !== decl.name.text) throw invalid();
        const name = decl.name.text;
        const delta = update.operator === ts.SyntaxKind.PlusPlusToken ? 1 : update.operator === ts.SyntaxKind.MinusMinusToken ? -1 : 0;
        const op = condition.operatorToken.kind;
        if (!(delta === 1 && (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken)) &&
            !(delta === -1 && (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken))) throw invalid();
        const unsafeBody = (n: ts.Node): boolean => {
          if (ts.isFunctionLike(n)) return false;
          if (ts.isBreakStatement(n) || ts.isContinueStatement(n) || ts.isReturnStatement(n) || ts.isThrowStatement(n)) return true;
          if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
              (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
              ts.isIdentifier(n.operand) && n.operand.text === name) return true;
          if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left) && n.left.text === name) return true;
          return ts.forEachChild(n, unsafeBody) === true;
        };
        if (unsafeBody(parent.statement)) throw invalid();
        scopes = scopes.flatMap((env) => {
          const unresolved = new LoopEvaluation();
          const start = this.evaluateNode(decl.initializer, env, unresolved);
          const end = this.evaluateNode(condition.right, env, unresolved);
          if (unresolved.size || start?.kind !== 'primitive' || typeof start.value !== 'number' || !Number.isSafeInteger(start.value) ||
              end?.kind !== 'primitive' || typeof end.value !== 'number' || !Number.isSafeInteger(end.value)) throw invalid();
          const inclusive = op === ts.SyntaxKind.LessThanEqualsToken || op === ts.SyntaxKind.GreaterThanEqualsToken;
          const length = Math.max(0, (end.value - start.value) * delta + Number(inclusive));
          if (length > remaining) throw new StaticForResolutionError(`Static for loop exceeds ${MAX_STATIC_FOR_ITERATIONS} iterations.`);
          remaining -= length;
          const startValue = start.value;
          return Array.from({ length }, (_, i) => {
            const iteration = createEnv(env);
            iteration.vars.set(name, { kind: 'primitive', value: startValue + i * delta });
            return iteration;
          });
        });
      }
    }
    if (!scopes.length) throw new StaticForResolutionError('The for loop has no iterations.');
    const iterations = scopes.map((env) => {
      const unresolved = new LoopEvaluation();
      const value = this.evaluateNode(node, env, unresolved);
      if (value?.kind !== 'locator' || unresolved.size) {
        throw new StaticForResolutionError('Cannot resolve all locator arguments inside the for loop.');
      }
      return value.descriptor;
    });
    const unique = [...new Map(iterations.map((item) => [item.humanReadable, item])).values()];
    const steps: LocatorStep[] = [...unique[0].steps, ...unique.slice(1).map((descriptor): LocatorStep => ({
      method: 'or', args: [{ __kind: 'locator', descriptor }],
    }))];
    return { steps, humanReadable: formatLocatorSteps(steps), iterations };
  }

  public getRecordedCalls(fnNode: ts.Node): FunctionCallRecord[] {
    return this.functionCalls.get(fnNode) || [];
  }

  public getClassInstanceForNode(
    node: ts.Node
  ): (AstValue & { kind: 'classInstance' }) | undefined {
    let cur: ts.Node | undefined = node;
    while (cur) {
      if (ts.isClassDeclaration(cur)) {
        return this.classInstances.get(cur);
      }
      cur = cur.parent;
    }
    return undefined;
  }

  /**
   * Создаёт объединённое окружение файла + основного класса + конструктора (+ строки курсора)
   * для вычисления вставленного пользователем сниппета локатора.
   */
  public createSnippetEnv(cursorLine?: number): ScopeEnv {
    const env = cloneEnv(this.rootEnv);
    const primaryClass = this.getPrimaryClassInstance();

    if (primaryClass) {
      env.vars.set('this', primaryClass);
      for (const [k, v] of primaryClass.classEnv.vars.entries()) {
        env.vars.set(k, v);
      }
      if (primaryClass.ctorEnv) {
        for (const [k, v] of primaryClass.ctorEnv.vars.entries()) {
          env.vars.set(k, v);
        }
      }
      // Если в классе есть параметризованные методы (например, getDeliverySwitch(label)),
      // добавляем их параметры как unresolvedParam, если имя параметра ещё не занято
      for (const methodDecl of primaryClass.methods.values()) {
        for (const param of methodDecl.parameters) {
          if (ts.isIdentifier(param.name) && !env.vars.has(param.name.text)) {
            env.vars.set(param.name.text, {
              kind: 'unresolvedParam',
              paramName: param.name.text,
            });
          }
        }
      }
    }

    // Если в конструкторе объявлены локальные параметризованные функции (например, fieldInputByLabel(labelText)),
    // добавляем их параметры как unresolvedParam, если имя ещё не занято
    for (const val of env.vars.values()) {
      if (val.kind === 'function') {
        for (const param of val.node.parameters) {
          if (ts.isIdentifier(param.name) && !env.vars.has(param.name.text)) {
            env.vars.set(param.name.text, {
              kind: 'unresolvedParam',
              paramName: param.name.text,
            });
          }
        }
      }
    }

    if (cursorLine && cursorLine > 0) {
      const lineIdx = Math.max(0, cursorLine - 1);
      const lineStarts = this.sf.getLineStarts();
      if (lineIdx < lineStarts.length) {
        const lineStart = lineStarts[lineIdx];
        const lineEnd =
          lineIdx + 1 < lineStarts.length
            ? lineStarts[lineIdx + 1] - 1
            : this.sf.text.length;
        let matchedNode: ts.Node | undefined;
        const findNodeOnLine = (n: ts.Node) => {
          const s = n.getStart(this.sf);
          const e = n.getEnd();
          if (s <= lineEnd && e >= lineStart) {
            if (this.nodeEnvs.has(n)) {
              matchedNode = n;
            }
            ts.forEachChild(n, findNodeOnLine);
          }
        };
        findNodeOnLine(this.sf);
        if (matchedNode) {
          const lineScope = this.findScopeForNode(matchedNode);
          let cur: ScopeEnv | undefined = lineScope;
          while (cur) {
            for (const [k, v] of cur.vars.entries()) {
              if (!env.vars.has(k)) {
                env.vars.set(k, v);
              }
            }
            cur = cur.parent;
          }
        }
      }
    }

    return env;
  }

  /**
   * Находит параметризованную функцию или метод класса по имени параметра или имени функции,
   * чтобы предложить варианты вызовов при резолве сниппета.
   */
  public findCallableForParamNames(
    paramNames: string[],
    env: ScopeEnv
  ):
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | undefined {
    const paramSet = new Set(paramNames);

    for (const val of env.vars.values()) {
      if (val.kind === 'function' && val.node.parameters.length > 0) {
        const matches = val.node.parameters.some(
          (p) => ts.isIdentifier(p.name) && paramSet.has(p.name.text)
        );
        if (matches) {
          return val.node;
        }
      }
    }

    const primaryClass = this.getPrimaryClassInstance();
    if (primaryClass) {
      for (const methodDecl of primaryClass.methods.values()) {
        const matches = methodDecl.parameters.some(
          (p) => ts.isIdentifier(p.name) && paramSet.has(p.name.text)
        );
        if (matches) {
          return methodDecl;
        }
      }
    }

    return undefined;
  }
}

interface CandidateLocatorNode {
  /** Выражение локатора (после отрезания терминального .click() и т.п.) */
  locatorExprNode: ts.Node;
  /** Полный узел для проверки попадания курсора (включая левую часть присваивания/свойства или вызов .click()) */
  hitRangeNode: ts.Node;
  /** Если был отрезан терминальный метод (.click() и т.д.) */
  strippedActionMethod?: string;
  /** Если узел находится внутри объявления параметризованной функции/метода */
  enclosingParamCallable?:
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration
    | ts.MethodDeclaration;
}

/**
 * Проверяет, является ли узел продолжением той же цепочки локатора (например, .filter() или .last() снаружи).
 */
function isParentContinuingLocatorChain(node: ts.Node): boolean {
  let current = node;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) {
    return false;
  }

  if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
    const propName = parent.name.text;
    const grandParent = parent.parent;
    if (grandParent && ts.isCallExpression(grandParent) && grandParent.expression === parent) {
      if (LOCATOR_CHAIN_METHODS.has(propName)) {
        return true;
      }
      return false;
    }
    // Если это цепочка обращения к свойству (например, this.deliverySection -> this.deliverySection.title)
    return true;
  }

  return false;
}

/**
 * Если поверх локатора вызван терминальный метод (например, .click()), возвращает имя этого метода и узел вызова.
 */
function findOuterActionCall(locatorExprNode: ts.Node): {
  actionMethod?: string;
  fullCallNode: ts.Node;
} {
  let current = locatorExprNode;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  if (
    parent &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === current &&
    TERMINAL_ACTION_METHODS.has(parent.name.text) &&
    parent.parent &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return {
      actionMethod: parent.name.text,
      fullCallNode: parent.parent,
    };
  }
  return { fullCallNode: locatorExprNode };
}

/**
 * Находит enclosing параметризованную функцию или метод, если узел находится внутри её объявления.
 */
function findEnclosingParameterizedCallable(
  node: ts.Node
):
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | undefined {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (
      (ts.isArrowFunction(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isFunctionDeclaration(cur) ||
        ts.isMethodDeclaration(cur)) &&
      cur.parameters.length > 0
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Основная точка входа AST-резолвера:
 * по позиции курсора (line, column) или выделению находит целевой локатор,
 * безопасно отрезает терминальные действия (.click(), .fill() и т.д.),
 * раскручивает this.*, локальные переменные, хелперы и импорты
 * и возвращает LocatorDescriptor (а для параметризованных хелперов/методов — также список вариантов).
 */
export function resolveLocatorAtPosition(
  options: ResolveLocatorOptions
): ResolvedLocatorResult {
  const filePath = path.resolve(options.filePath);
  const sourceText =
    options.sourceText !== undefined
      ? options.sourceText
      : fs.readFileSync(filePath, 'utf8');

  const analyzer = new FileLocatorAnalyzer(filePath, sourceText);
  const sf = analyzer.getSourceFile();

  const lineIndex = Math.max(0, options.line - 1);
  const colIndex = Math.max(0, options.column - 1);
  const cursorOffset = sf.getPositionOfLineAndCharacter(lineIndex, colIndex);

  const lineStarts = sf.getLineStarts();
  const lineStartOffset = lineStarts[lineIndex] ?? 0;
  const lineEndOffset =
    lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] - 1 : sourceText.length;

  // 1. Проверяем, не находится ли курсор внутри объявления параметризованной фабрики/метода локатора
  // (например, fieldInputByLabel на строках 75-82 или getDeliverySwitch на строках 181-191)
  const candidates: CandidateLocatorNode[] = [];

  const canEvaluateToLocator = (exprNode: ts.Node): boolean => {
    const scope = analyzer.findScopeForNode(exprNode);
    const enclosingCallable = findEnclosingParameterizedCallable(exprNode);
    if (enclosingCallable) {
      for (const param of enclosingCallable.parameters) {
        if (ts.isIdentifier(param.name) && !scope.vars.has(param.name.text)) {
          scope.vars.set(param.name.text, {
            kind: 'unresolvedParam',
            paramName: param.name.text,
          });
        }
      }
    }
    const testUnresolved = new Set<string>();
    const val = analyzer.evaluateNode(exprNode, scope, testUnresolved);
    return val?.kind === 'locator';
  };

  const collectCandidates = (node: ts.Node) => {
    // 1) Присваивание в конструкторе: this.contentRoot = <locator>
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      canEvaluateToLocator(node.right)
    ) {
      candidates.push({
        locatorExprNode: node.right,
        hitRangeNode: node,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
    }

    // 1b) Объявление поля класса: readonly mainPageTitle: Locator;
    if (
      ts.isPropertyDeclaration(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      canEvaluateToLocator(node)
    ) {
      candidates.push({
        locatorExprNode: node,
        hitRangeNode: node,
      });
    }

    // 2) Объявление переменной: const profileRoot = <locator>
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (canEvaluateToLocator(node.initializer)) {
        candidates.push({
          locatorExprNode: node.initializer,
          hitRangeNode: node,
          enclosingParamCallable: findEnclosingParameterizedCallable(node),
        });
      } else if (
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer)) &&
        node.initializer.parameters.length > 0
      ) {
        // Стрелочная функция-фабрика локатора: const fieldInputByLabel = (labelText: string): Locator => ...
        const fnNode = node.initializer;
        const bodyExpr = !ts.isBlock(fnNode.body)
          ? fnNode.body
          : fnNode.body.statements.find(ts.isReturnStatement)?.expression;
        if (bodyExpr && canEvaluateToLocator(bodyExpr)) {
          candidates.push({
            locatorExprNode: bodyExpr,
            hitRangeNode: node.parent?.parent && ts.isVariableStatement(node.parent.parent)
              ? node.parent.parent
              : node,
            enclosingParamCallable: fnNode,
          });
        }
      }
    }

    // 3) Метод класса, возвращающий локатор: getDeliverySwitch(label: string): Locator { return ... }
    if (ts.isMethodDeclaration(node) && node.body && node.parameters.length > 0) {
      const retStmt = node.body.statements.find(ts.isReturnStatement);
      if (retStmt?.expression && canEvaluateToLocator(retStmt.expression)) {
        candidates.push({
          locatorExprNode: retStmt.expression,
          hitRangeNode: node,
          enclosingParamCallable: node,
        });
      }
    }

    // 4) Свойство в объекте: root: profileRoot, phoneInput: fieldInputByLabel(...), title: deliveryRoot.getByText(...)
    if (ts.isPropertyAssignment(node) && canEvaluateToLocator(node.initializer)) {
      candidates.push({
        locatorExprNode: node.initializer,
        hitRangeNode: node,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
    }

    if (ts.isShorthandPropertyAssignment(node) && canEvaluateToLocator(node.name)) {
      candidates.push({
        locatorExprNode: node.name,
        hitRangeNode: node,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
    }

    // 5) Максимальные выражения-цепочки локаторов (включая вложенные в .filter({ has: ... }) и перед .click()),
    // а при непустом выделении (options.selection) — также промежуточные под-цепочки, заканчивающиеся внутри выделения
    const hasNonEmptySelection = Boolean(
      options.selection &&
        (options.selection.startLine !== options.selection.endLine ||
          options.selection.startColumn !== options.selection.endColumn)
    );
    const selEndOffset =
      hasNonEmptySelection && options.selection
        ? sf.getPositionOfLineAndCharacter(
            Math.max(0, options.selection.endLine - 1),
            Math.max(0, options.selection.endColumn - 1)
          )
        : -1;
    const isSubchainAtSelectionBoundary =
      hasNonEmptySelection &&
      ts.isCallExpression(node) &&
      node.getEnd() <= selEndOffset + 2 &&
      node.parent &&
      node.parent.getEnd() > selEndOffset + 2;

    if (
      (ts.isCallExpression(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isIdentifier(node)) &&
      (!isParentContinuingLocatorChain(node) || isSubchainAtSelectionBoundary) &&
      canEvaluateToLocator(node)
    ) {
      const { actionMethod, fullCallNode } = isSubchainAtSelectionBoundary
        ? { actionMethod: undefined, fullCallNode: node }
        : findOuterActionCall(node);
      candidates.push({
        locatorExprNode: node,
        hitRangeNode: fullCallNode,
        strippedActionMethod: actionMethod,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
    }

    ts.forEachChild(node, collectCandidates);
  };

  collectCandidates(sf);

  if (candidates.length === 0) {
    throw new Error(
      `No Playwright Locator expression found on line ${options.line}.`
    );
  }

  // Выбираем лучшего кандидата по позиции курсора (line + column)
  const chosen = pickBestCandidate(
    candidates,
    sf,
    cursorOffset,
    lineStartOffset,
    lineEndOffset,
    options.selection
  );

  return buildResultFromCandidate(
    chosen,
    analyzer,
    sf,
    options.parameterOverrides
  );
}

function pickBestCandidate(
  candidates: CandidateLocatorNode[],
  sf: ts.SourceFile,
  cursorOffset: number,
  lineStartOffset: number,
  lineEndOffset: number,
  selection?: ResolveLocatorOptions['selection']
): CandidateLocatorNode {
  // 0. Если узел находится внутри параметризованной стрелочной функции или метода-фабрики локатора
  // (например, fieldInputByLabel на строках 75-82 или getDeliverySwitch на строках 181-191),
  // и сам кандидат представляет эту фабрику/метод целиком, проверяем попадание курсора.
  const factoryCandidates = candidates.filter((c) => {
    if (!c.enclosingParamCallable) {
      return false;
    }
    const start = c.hitRangeNode.getStart(sf);
    const end = c.hitRangeNode.getEnd();
    return (
      cursorOffset >= start &&
      cursorOffset <= end &&
      (c.hitRangeNode === c.enclosingParamCallable ||
        ts.isVariableStatement(c.hitRangeNode) ||
        ts.isVariableDeclaration(c.hitRangeNode) ||
        ts.isMethodDeclaration(c.hitRangeNode))
    );
  });

  if (factoryCandidates.length > 0 && !selection) {
    return factoryCandidates[0];
  }

  // 1. Если есть непустое выделение — ищем кандидата, наиболее близкого к выделению (включая выделенную под-цепочку)
  if (
    selection &&
    (selection.startLine !== selection.endLine ||
      selection.startColumn !== selection.endColumn)
  ) {
    const selStart = sf.getPositionOfLineAndCharacter(
      Math.max(0, selection.startLine - 1),
      Math.max(0, selection.startColumn - 1)
    );
    const selEnd = sf.getPositionOfLineAndCharacter(
      Math.max(0, selection.endLine - 1),
      Math.max(0, selection.endColumn - 1)
    );
    // Сначала проверяем кандидатов (в т.ч. под-цепочки), чей конец совпадает с концом выделения,
    // а начало находится около или внутри начала выделения
    const endMatched = candidates.filter((c) => {
      const start = c.locatorExprNode.getStart(sf);
      const hitStart = c.hitRangeNode.getStart(sf);
      const end = c.locatorExprNode.getEnd();
      return (
        Math.abs(end - selEnd) <= 3 &&
        (start >= selStart - 2 || hitStart <= selStart + 2) &&
        start < selEnd
      );
    });
    if (endMatched.length > 0) {
      endMatched.sort(
        (a, b) =>
          Math.abs(a.locatorExprNode.getEnd() - selEnd) -
            Math.abs(b.locatorExprNode.getEnd() - selEnd) ||
          a.locatorExprNode.getEnd() -
            a.locatorExprNode.getStart(sf) -
            (b.locatorExprNode.getEnd() - b.locatorExprNode.getStart(sf))
      );
      return endMatched[0];
    }

    const containingSelection = candidates.filter((c) => {
      const start = c.hitRangeNode.getStart(sf);
      const end = c.hitRangeNode.getEnd();
      return start <= selStart && end >= selEnd;
    });
    if (containingSelection.length > 0) {
      containingSelection.sort(
        (a, b) =>
          a.hitRangeNode.getEnd() -
          a.hitRangeNode.getStart(sf) -
          (b.hitRangeNode.getEnd() - b.hitRangeNode.getStart(sf))
      );
      return containingSelection[0];
    }
  }

  // 2. Кандидаты, чей диапазон напрямую содержит cursorOffset
  const directHits = candidates.filter((c) => {
    const start = c.hitRangeNode.getStart(sf);
    const end = c.hitRangeNode.getEnd();
    return cursorOffset >= start && cursorOffset <= end;
  });

  if (directHits.length > 0) {
    // Выбираем самый узкий (специфичный) диапазон;
    // при равной длине предпочитаем узел с strippedActionMethod или выражение локатора
    directHits.sort((a, b) => {
      const spanA = a.locatorExprNode.getEnd() - a.locatorExprNode.getStart(sf);
      const spanB = b.locatorExprNode.getEnd() - b.locatorExprNode.getStart(sf);
      if (spanA !== spanB) {
        return spanA - spanB;
      }
      const hitSpanA = a.hitRangeNode.getEnd() - a.hitRangeNode.getStart(sf);
      const hitSpanB = b.hitRangeNode.getEnd() - b.hitRangeNode.getStart(sf);
      return hitSpanA - hitSpanB;
    });
    return directHits[0];
  }

  // 3. Если курсор стоит в отступе в начале/конце строки — ищем кандидатов, пересекающих эту строку
  const lineHits = candidates.filter((c) => {
    const start = c.hitRangeNode.getStart(sf);
    const end = c.hitRangeNode.getEnd();
    return start <= lineEndOffset && end >= lineStartOffset;
  });

  if (lineHits.length > 0) {
    // Если курсор стоит в начале строки (до первого токена), предпочитаем кандидата,
    // который начинается на этой строке, либо внешний контейнер этой строки
    lineHits.sort((a, b) => {
      const startA = a.hitRangeNode.getStart(sf);
      const startB = b.hitRangeNode.getStart(sf);
      const distA =
        cursorOffset < startA
          ? startA - cursorOffset
          : cursorOffset > a.hitRangeNode.getEnd()
            ? cursorOffset - a.hitRangeNode.getEnd()
            : 0;
      const distB =
        cursorOffset < startB
          ? startB - cursorOffset
          : cursorOffset > b.hitRangeNode.getEnd()
            ? cursorOffset - b.hitRangeNode.getEnd()
            : 0;
      if (distA !== distB) {
        return distA - distB;
      }
      const spanA = a.hitRangeNode.getEnd() - startA;
      const spanB = b.hitRangeNode.getEnd() - startB;
      return spanA - spanB;
    });
    return lineHits[0];
  }

  throw new Error('No Playwright locator found at the current cursor position.');
}

function collectLeafTokens(node: ts.Node, sf: ts.SourceFile, out: ts.Node[] = []): ts.Node[] {
  const children = node.getChildren(sf);
  if (children.length === 0) {
    if (node.getEnd() > node.getStart(sf)) {
      out.push(node);
    }
    return out;
  }
  for (const child of children) {
    collectLeafTokens(child, sf, out);
  }
  return out;
}

const BINARY_SPACED_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.EqualsGreaterThanToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function isWordLikeToken(text: string): boolean {
  return /^[a-zA-Z0-9_$]/.test(text) && /[a-zA-Z0-9_$]$/.test(text);
}

/**
 * Форматирует AST-узел в чистую компактную однострочную цепочку без комментариев (// и /* * /),
 * без висящих запятых и без пробелов перед точками (.locator, .filter и т.д.).
 */
export function formatAstNodeCompact(node: ts.Node, sf: ts.SourceFile): string {
  const rawLeaves = collectLeafTokens(node, sf);
  if (rawLeaves.length === 0) {
    return '';
  }

  // Отфильтровываем висящие запятые перед }, ), ]
  const leaves: ts.Node[] = [];
  for (let i = 0; i < rawLeaves.length; i++) {
    const cur = rawLeaves[i];
    const next = rawLeaves[i + 1];
    if (
      cur.kind === ts.SyntaxKind.CommaToken &&
      next &&
      (next.kind === ts.SyntaxKind.CloseBraceToken ||
        next.kind === ts.SyntaxKind.CloseParenToken ||
        next.kind === ts.SyntaxKind.CloseBracketToken)
    ) {
      continue;
    }
    leaves.push(cur);
  }

  const parts: string[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const cur = leaves[i];
    const prev = i > 0 ? leaves[i - 1] : undefined;
    const curText = cur.getText(sf);

    if (prev) {
      const prevText = prev.getText(sf);
      let needSpace = false;

      if (
        prev.kind === ts.SyntaxKind.CommaToken ||
        prev.kind === ts.SyntaxKind.ColonToken ||
        prev.kind === ts.SyntaxKind.SemicolonToken
      ) {
        needSpace = true;
      } else if (
        prev.kind === ts.SyntaxKind.OpenBraceToken &&
        cur.kind !== ts.SyntaxKind.CloseBraceToken
      ) {
        needSpace = true;
      } else if (
        cur.kind === ts.SyntaxKind.CloseBraceToken &&
        prev.kind !== ts.SyntaxKind.OpenBraceToken
      ) {
        needSpace = true;
      } else if (
        BINARY_SPACED_TOKENS.has(prev.kind) ||
        BINARY_SPACED_TOKENS.has(cur.kind)
      ) {
        needSpace = true;
      } else if (isWordLikeToken(prevText) && isWordLikeToken(curText)) {
        needSpace = true;
      } else if (
        isWordLikeToken(prevText) &&
        (cur.kind === ts.SyntaxKind.OpenBraceToken ||
          cur.kind === ts.SyntaxKind.StringLiteral ||
          cur.kind === ts.SyntaxKind.RegularExpressionLiteral)
      ) {
        needSpace = true;
      }

      if (needSpace) {
        parts.push(' ');
      }
    }

    parts.push(curText);
  }

  return parts.join('').trim();
}

/**
 * Вычисляет список активных (незакомментированных) диапазонов строк для узла AST,
 * чтобы подсветка в редакторе пропускала закомментированные строки // ... внутри цепочки.
 */
function computeActiveLineRanges(node: ts.Node, sf: ts.SourceFile): SourceLineRange[] {
  const leaves = collectLeafTokens(node, sf);
  const byLine = new Map<number, { minCol: number; maxCol: number }>();

  for (const leaf of leaves) {
    const startPos = sf.getLineAndCharacterOfPosition(leaf.getStart(sf));
    const endPos = sf.getLineAndCharacterOfPosition(leaf.getEnd());

    for (let l = startPos.line; l <= endPos.line; l++) {
      const colStart = l === startPos.line ? startPos.character + 1 : 1;
      const colEnd =
        l === endPos.line
          ? endPos.character + 1
          : (sf.getLineStarts()[l + 1] ?? sf.text.length) - sf.getLineStarts()[l];
      const existing = byLine.get(l);
      if (!existing) {
        byLine.set(l, { minCol: colStart, maxCol: colEnd });
      } else {
        existing.minCol = Math.min(existing.minCol, colStart);
        existing.maxCol = Math.max(existing.maxCol, colEnd);
      }
    }
  }

  const lines = Array.from(byLine.keys()).sort((a, b) => a - b);
  return lines.map((lineIdx) => {
    const bounds = byLine.get(lineIdx)!;
    return {
      startLine: lineIdx + 1,
      startColumn: bounds.minCol,
      endLine: lineIdx + 1,
      endColumn: bounds.maxCol,
    };
  });
}

/**
 * Очищает произвольный вставленный фрагмент кода от комментариев и многострочных отступов,
 * возвращая компактную однострочную запись.
 */
export function formatCompactCodeExpression(rawSnippet: string): string {
  const trimmed = rawSnippet.trim();
  if (!trimmed) {
    return '';
  }
  if (extractPureSelectorString(trimmed)) {
    return trimmed.replace(/\s+/g, ' ').trim();
  }
  try {
    const sf = ts.createSourceFile(
      '__compact__.ts',
      trimmed,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const formatted = formatAstNodeCompact(sf, sf);
    if (formatted) {
      return formatted;
    }
  } catch {
    // ignore
  }
  return trimmed.replace(/\s+/g, ' ').trim();
}

function buildResultFromCandidate(
  candidate: CandidateLocatorNode,
  analyzer: FileLocatorAnalyzer,
  sf: ts.SourceFile,
  parameterOverrides?: Record<string, SerializedArg>
): ResolvedLocatorResult {
  const startPos = sf.getLineAndCharacterOfPosition(
    candidate.hitRangeNode.getStart(sf)
  );
  const endPos = sf.getLineAndCharacterOfPosition(candidate.hitRangeNode.getEnd());
  const range: SourceLineRange = {
    startLine: startPos.line + 1,
    startColumn: startPos.character + 1,
    endLine: endPos.line + 1,
    endColumn: endPos.character + 1,
  };
  const activeLineRanges = computeActiveLineRanges(candidate.hitRangeNode, sf);

  const expressionText =
    formatAstNodeCompact(candidate.locatorExprNode, sf) ||
    candidate.locatorExprNode
      .getText(sf)
      .replace(/\s+/g, ' ')
      .trim();

  const loopDescriptor = analyzer.resolveForLocator(candidate.locatorExprNode, parameterOverrides);
  if (loopDescriptor) {
    return {
      expressionText, range, activeLineRanges,
      strippedActionMethod: candidate.strippedActionMethod,
      descriptor: loopDescriptor,
      requiresParameterSelection: false, parameterNames: [], variants: [],
    };
  }
  const baseScope = analyzer.findScopeForNode(candidate.locatorExprNode);
  const callable = candidate.enclosingParamCallable;

  if (callable) {
    for (const param of callable.parameters) {
      if (ts.isIdentifier(param.name) && !baseScope.vars.has(param.name.text)) {
        baseScope.vars.set(param.name.text, {
          kind: 'unresolvedParam',
          paramName: param.name.text,
        });
      }
    }
  }

  if (parameterOverrides) {
    for (const [k, v] of Object.entries(parameterOverrides)) {
      baseScope.vars.set(k, serializedArgToAstValue(v));
    }
  }

  const unresolvedParams = new Set<string>();
  const evalResult = analyzer.evaluateNode(
    candidate.locatorExprNode,
    baseScope,
    unresolvedParams
  );

  if (evalResult?.kind !== 'locator') {
    throw new Error(`Failed to resolve locator for expression: ${expressionText}`);
  }

  // Если свободных параметров нет — проверяем, есть ли варианты из super(...) наследников
  if (unresolvedParams.size === 0) {
    const subclassVariants = analyzer.buildSubclassLocatorVariants(
      candidate.locatorExprNode,
      evalResult.descriptor,
      baseScope
    );
    if (subclassVariants.length > 1) {
      return {
        expressionText,
        range,
        activeLineRanges,
        strippedActionMethod: candidate.strippedActionMethod,
        descriptor: evalResult.descriptor,
        requiresParameterSelection: true,
        parameterNames: ['Context'],
        variantKind: 'context',
        variants: subclassVariants,
      };
    }
    return {
      expressionText,
      range,
      activeLineRanges,
      strippedActionMethod: candidate.strippedActionMethod,
      descriptor: evalResult.descriptor,
      requiresParameterSelection: false,
      parameterNames: [],
      variants: [],
    };
  }

  // Если есть свободные параметры (например, внутри тела fieldInputByLabel или getDeliverySwitch),
  // собираем все варианты вызова из класса и констант
  const parameterNames = Array.from(unresolvedParams);
  const variants: LocatorVariant[] = [];

  if (callable) {
    const recordedCalls = analyzer.getRecordedCalls(callable);
    for (const callRec of recordedCalls) {
      const variantScope = cloneEnv(baseScope);
      const paramsObj: Record<string, SerializedArg> = {};
      for (const [pName, pVal] of Object.entries(callRec.argsByName)) {
        variantScope.vars.set(pName, pVal);
        paramsObj[pName] = astValueToSerializedArg(pVal, new Set());
      }
      const checkUnresolved = new Set<string>();
      const vEval = analyzer.evaluateNode(
        candidate.locatorExprNode,
        variantScope,
        checkUnresolved
      );
      if (vEval?.kind === 'locator' && checkUnresolved.size === 0) {
        variants.push({
          id: callRec.callerName,
          label: callRec.callerName,
          description: vEval.descriptor.humanReadable,
          parameters: paramsObj,
          descriptor: vEval.descriptor,
        });
      }
    }

    // Если у метода 1 строковый параметр и вызовов еще не найдено,
    // ищем массивы строковых констант в классе
    if (variants.length === 0 && parameterNames.length === 1) {
      const singleParam = parameterNames[0];
      const classInst = analyzer.getClassInstanceForNode(callable);
      if (classInst) {
        const stringArrays = collectStringArraysFromClassProps(classInst.props);
        for (const arrItem of stringArrays) {
          for (const strVal of arrItem.values) {
            const variantScope = cloneEnv(baseScope);
            variantScope.vars.set(singleParam, { kind: 'primitive', value: strVal });
            const checkUnresolved = new Set<string>();
            const vEval = analyzer.evaluateNode(
              candidate.locatorExprNode,
              variantScope,
              checkUnresolved
            );
            if (vEval?.kind === 'locator' && checkUnresolved.size === 0) {
              variants.push({
                id: `${arrItem.path}:${strVal}`,
                label: `${singleParam} = "${strVal}"`,
                description: arrItem.path,
                parameters: { [singleParam]: strVal },
                descriptor: vEval.descriptor,
              });
            }
          }
        }
      }
    }
  }

  return {
    expressionText,
    range,
    activeLineRanges,
    strippedActionMethod: candidate.strippedActionMethod,
    descriptor: variants[0]?.descriptor,
    requiresParameterSelection: true,
    parameterNames,
    variants,
  };
}

function collectStringArraysFromClassProps(
  props: Map<string, AstValue>
): Array<{ path: string; values: string[] }> {
  const result: Array<{ path: string; values: string[] }> = [];

  const visit = (val: AstValue, curPath: string) => {
    if (val.kind === 'array') {
      const strings = val.elements
        .filter(
          (el): el is { kind: 'primitive'; value: string } =>
            el.kind === 'primitive' && typeof el.value === 'string'
        )
        .map((el) => el.value);
      if (strings.length > 0 && strings.length === val.elements.length) {
        result.push({ path: curPath, values: strings });
      }
    } else if (val.kind === 'object') {
      for (const [k, v] of val.properties.entries()) {
        visit(v, curPath ? `${curPath}.${k}` : k);
      }
    }
  };

  for (const [k, v] of props.entries()) {
    visit(v, `this.${k}`);
  }

  return result;
}

function isAssertionMethodName(name: string): boolean {
  return (
    name.startsWith('toBe') ||
    name.startsWith('toHave') ||
    name.startsWith('toContain') ||
    name.startsWith('toMatch') ||
    name.startsWith('toEqual')
  );
}

function isExpectCallNode(node: ts.Node): node is ts.CallExpression {
  const n = unwrapParensAndTypes(node);
  if (!ts.isCallExpression(n) || n.arguments.length === 0) {
    return false;
  }
  const callee = unwrapParensAndTypes(n.expression);
  if (ts.isIdentifier(callee) && callee.text === 'expect') {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'expect' &&
    (callee.name.text === 'soft' || callee.name.text === 'poll')
  ) {
    return true;
  }
  return false;
}

/**
 * Разворачивает внешние обёртки действий (.click(), .fill() и т.д.) и проверок (await expect(loc).toBeVisible()),
 * возвращая чистый AST-узел локатора и имя отрезанного терминального метода.
 */
function unwrapActionAndExpectNode(rawNode: ts.Node): {
  coreNode: ts.Node;
  strippedActionMethod?: string;
} {
  let cur = unwrapParensAndTypes(rawNode);
  let strippedActionMethod: string | undefined;

  while (true) {
    if (ts.isCallExpression(cur)) {
      const callee = unwrapParensAndTypes(cur.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const methodName = callee.name.text;
        if (
          TERMINAL_ACTION_METHODS.has(methodName) ||
          isAssertionMethodName(methodName)
        ) {
          if (!strippedActionMethod) {
            strippedActionMethod = methodName;
          }
          cur = unwrapParensAndTypes(callee.expression);
          continue;
        }
      }
      if (isExpectCallNode(cur)) {
        if (!strippedActionMethod) {
          strippedActionMethod = 'expect';
        }
        cur = unwrapParensAndTypes(cur.arguments[0]);
        continue;
      }
    }
    if (
      ts.isPropertyAccessExpression(cur) &&
      (cur.name.text === 'not' ||
        cur.name.text === 'soft' ||
        cur.name.text === 'resolves' ||
        cur.name.text === 'rejects')
    ) {
      cur = unwrapParensAndTypes(cur.expression);
      continue;
    }
    break;
  }

  return { coreNode: cur, strippedActionMethod };
}

/**
 * Нормализует вставленный пользователем фрагмент кода перед парсингом TypeScript AST.
 */
function normalizeLocatorSnippetText(rawSnippet: string): string {
  let text = rawSnippet.trim();
  // Убираем висящую запятую в конце (когда скопировано свойство объекта или аргумент)
  text = text.replace(/,\s*$/, '').trim();

  // Если цепочка начинается с ведущей точки: .locator('div')... или .getByTestId('...')
  if (
    /^\.\s*(locator|getByRole|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle|getByTestId|frameLocator)\b/.test(
      text
    )
  ) {
    text = `page${text}`;
  }

  // Если скопировано объявление поля класса: readonly mainPageTitle: Locator; или mainPageTitle: Locator;
  const classFieldMatch = text.match(
    /^(?:(?:public|private|protected|readonly)\s+)+([a-zA-Z_$][\w$]*)\s*(?::[^=;]+)?(?:\s*=\s*([\s\S]+))?;?$/
  );
  if (classFieldMatch) {
    const fieldName = classFieldMatch[1];
    const initializer = classFieldMatch[2]?.replace(/;\s*$/, '').trim();
    text = initializer ? `this.${fieldName} = ${initializer}` : `this.${fieldName}`;
  } else if (/^([a-zA-Z_$][\w$]*)\s*:\s*Locator\s*;?$/.test(text)) {
    const fieldName = text.replace(/\s*:\s*Locator\s*;?$/, '').trim();
    text = `this.${fieldName}`;
  }

  // Если скопирован метод класса без ключевого слова function: getDeliverySwitch(label: string): Locator { ... }
  if (
    /^(?:(?:public|private|protected|async)\s+)*([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{[\s\S]*\}$/.test(
      text
    ) &&
    !/^(function|if|for|while|switch|catch)\b/.test(text)
  ) {
    text = text.replace(/^(?:(?:public|private|protected)\s+)+/, '');
    text = text.startsWith('async ')
      ? text.replace(/^async\s+/, 'async function ')
      : `function ${text}`;
  }

  // Если скопировано свойство объекта без внешних фигурных скобок:
  // title: profileRoot.getByText(...) или root: profileRoot
  if (
    /^[a-zA-Z_$][\w$]*\s*:\s*[\s\S]+$/.test(text) &&
    !/^(https?|xpath|css|text|id|data-testid|data-qa|internal|role):/i.test(text)
  ) {
    const colonIdx = text.indexOf(':');
    const rhs = text.slice(colonIdx + 1).trim();
    if (rhs) {
      text = rhs;
    }
  }

  return text;
}

const HTML_TAG_SELECTOR_REGEX =
  /^(div|span|input|button|label|form|a|img|h[1-6]|p|ul|ol|li|table|thead|tbody|tr|td|th|svg|path|section|header|footer|main|nav|textarea|select|option|iframe|dialog|article|aside)([.#[:\s>+~]|$)/i;

/**
 * Проверяет, является ли строка чистым CSS / XPath / Playwright селектором без вызовов JS-методов.
 */
function extractPureSelectorString(rawSnippet: string): string | undefined {
  const trimmed = rawSnippet.trim();
  if (!trimmed) {
    return undefined;
  }

  // Исключаем выражения кода с page., this., await, expect, объявлениями переменных и вызовами методов локатора
  if (
    /^(this\.|page\.|await\b|expect\s*\(|const\b|let\b|var\b|return\b|readonly\b)/.test(
      trimmed
    ) ||
    /\b(getByRole|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle|getByTestId|frameLocator)\s*\(/.test(
      trimmed
    ) ||
    /\.locator\s*\(/.test(trimmed) ||
    /\.filter\s*\(/.test(trimmed)
  ) {
    return undefined;
  }

  let candidate = trimmed;
  // Если селектор вставлен в парных кавычках ('[data-qa="..."]' или ".hidden h1")
  if (
    (candidate.startsWith("'") && candidate.endsWith("'")) ||
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith('`') && candidate.endsWith('`'))
  ) {
    const inner = candidate.slice(1, -1).trim();
    if (inner && !inner.includes('${')) {
      return inner;
    }
  }

  if (
    candidate.startsWith('[') ||
    candidate.startsWith('.') ||
    candidate.startsWith('#') ||
    candidate.startsWith('//') ||
    candidate.startsWith('..') ||
    candidate.startsWith('>') ||
    /^(xpath|css|text|id|data-testid|data-qa|role|internal)=/i.test(candidate) ||
    HTML_TAG_SELECTOR_REGEX.test(candidate)
  ) {
    return candidate;
  }

  return undefined;
}

/**
 * Ищет в проекте подходящие файлы Page Object / Component, если в текущем активном файле
 * нет используемых в сниппете полей this.* или локальных переменных конструктора.
 */
function findFallbackContextFilesForSnippet(
  snippetText: string,
  startFilePath?: string
): string[] {
  const projectRoot = findProjectRootFromFile(startFilePath || process.cwd());
  const thisProps = new Set<string>();
  const thisRegex = /\bthis\.([a-zA-Z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = thisRegex.exec(snippetText)) !== null) {
    if (m[1] !== 'page') {
      thisProps.add(m[1]);
    }
  }

  const identifiers = new Set<string>();
  const idRegex = /\b([a-zA-Z_$][\w$]*)\b/g;
  const reserved = new Set([
    'this',
    'page',
    'const',
    'let',
    'var',
    'await',
    'expect',
    'return',
    'true',
    'false',
    'null',
    'undefined',
    'exact',
    'has',
    'hasNot',
    'hasText',
    'hasNotText',
    'name',
    'div',
    'span',
    'input',
    'button',
    ...LOCATOR_CHAIN_METHODS,
    ...TERMINAL_ACTION_METHODS,
  ]);
  while ((m = idRegex.exec(snippetText)) !== null) {
    if (!reserved.has(m[1])) {
      identifiers.add(m[1]);
    }
  }

  if (thisProps.size === 0 && identifiers.size === 0) {
    return [];
  }

  const searchRoots = [
    path.join(projectRoot, 'src', 'pages'),
    path.join(projectRoot, 'src', 'components'),
    path.join(projectRoot, 'src'),
  ];

  const visitedFiles = new Set<string>();
  if (startFilePath) {
    visitedFiles.add(path.resolve(startFilePath));
  }

  const scoredFiles: Array<{ filePath: string; score: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 5 || !fs.existsSync(dir)) {
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const resolved = path.resolve(full);
        if (visitedFiles.has(resolved)) {
          continue;
        }
        visitedFiles.add(resolved);
        try {
          const content = fs.readFileSync(resolved, 'utf8');
          let score = 0;
          for (const prop of thisProps) {
            if (content.includes(`this.${prop}`) || content.includes(`readonly ${prop}`)) {
              score += 5;
            }
          }
          for (const id of identifiers) {
            if (content.includes(id)) {
              score += 2;
            }
          }
          if (score > 0) {
            scoredFiles.push({ filePath: resolved, score });
          }
        } catch {
          // ignore
        }
      } else if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        !entry.name.startsWith('.')
      ) {
        walk(full, depth + 1);
      }
    }
  };

  for (const root of searchRoots) {
    walk(root, 0);
  }

  scoredFiles.sort((a, b) => b.score - a.score);
  return scoredFiles.slice(0, 5).map((item) => item.filePath);
}

/**
 * Пытается вычислить сниппет локатора в рамках заданного FileLocatorAnalyzer.
 */
function tryResolveSnippetWithAnalyzer(
  normalizedSnippet: string,
  rawSnippet: string,
  analyzer: FileLocatorAnalyzer,
  cursorLine?: number,
  parameterOverrides?: Record<string, SerializedArg>
): ResolvedLocatorResult | undefined {
  const snippetSf = ts.createSourceFile(
    '__snippet__.ts',
    normalizedSnippet,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const env = analyzer.createSnippetEnv(cursorLine);
  if (parameterOverrides) {
    for (const [k, v] of Object.entries(parameterOverrides)) {
      env.vars.set(k, serializedArgToAstValue(v));
    }
  }

  // Если сниппет содержит несколько стейтментов, последовательно выполняем объявления/присваивания
  for (let i = 0; i < snippetSf.statements.length; i++) {
    const stmt = snippetSf.statements[i];
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const val = analyzer.evaluateNode(
            decl.initializer,
            env,
            new Set(),
            decl.name.text
          );
          if (val) {
            env.vars.set(decl.name.text, val);
          }
        }
      }
    } else if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const bin = stmt.expression;
      const left = unwrapParensAndTypes(bin.left);
      if (
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const val = analyzer.evaluateNode(
          bin.right,
          env,
          new Set(),
          `this.${left.name.text}`
        );
        const thisInst = lookupEnv(env, 'this');
        if (val && thisInst?.kind === 'classInstance') {
          thisInst.props.set(left.name.text, val);
        }
      }
    }
  }

  interface SnippetCandidate {
    locatorExprNode: ts.Node;
    strippedActionMethod?: string;
    callable?:
      | ts.ArrowFunction
      | ts.FunctionExpression
      | ts.FunctionDeclaration
      | ts.MethodDeclaration;
  }

  const buildResolvedResult = (
    cand: SnippetCandidate
  ): ResolvedLocatorResult | undefined => {
    const evalEnv = cloneEnv(env);
    if (cand.callable) {
      for (const param of cand.callable.parameters) {
        if (ts.isIdentifier(param.name) && !evalEnv.vars.has(param.name.text)) {
          evalEnv.vars.set(param.name.text, {
            kind: 'unresolvedParam',
            paramName: param.name.text,
          });
        }
      }
    }
    if (parameterOverrides) {
      for (const [k, v] of Object.entries(parameterOverrides)) {
        evalEnv.vars.set(k, serializedArgToAstValue(v));
      }
    }

    const unresolvedParams = new Set<string>();
    const val = analyzer.evaluateNode(
      cand.locatorExprNode,
      evalEnv,
      unresolvedParams
    );
    if (val?.kind !== 'locator') {
      return undefined;
    }

    const expressionText =
      formatAstNodeCompact(cand.locatorExprNode, snippetSf) ||
      formatCompactCodeExpression(rawSnippet);

    const range = {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: expressionText.length + 1,
    };

    if (unresolvedParams.size === 0) {
      const subclassVariants = analyzer.buildSubclassLocatorVariants(
        cand.locatorExprNode,
        val.descriptor,
        evalEnv,
        analyzer.getPrimaryClassDeclaration()
      );
      if (subclassVariants.length > 1) {
        return {
          expressionText,
          range,
          strippedActionMethod: cand.strippedActionMethod,
          descriptor: val.descriptor,
          requiresParameterSelection: true,
          parameterNames: ['Context'],
          variantKind: 'context',
          variants: subclassVariants,
        };
      }
      return {
        expressionText,
        range,
        strippedActionMethod: cand.strippedActionMethod,
        descriptor: val.descriptor,
        requiresParameterSelection: false,
        parameterNames: [],
        variants: [],
      };
    }

    const parameterNames = Array.from(unresolvedParams);
    const variants: LocatorVariant[] = [];
    const callable =
      cand.callable || analyzer.findCallableForParamNames(parameterNames, evalEnv);

    if (callable) {
      const recordedCalls = analyzer.getRecordedCalls(callable);
      for (const callRec of recordedCalls) {
        const variantScope = cloneEnv(evalEnv);
        const paramsObj: Record<string, SerializedArg> = {};
        for (const [pName, pVal] of Object.entries(callRec.argsByName)) {
          variantScope.vars.set(pName, pVal);
          paramsObj[pName] = astValueToSerializedArg(pVal, new Set());
        }
        const checkUnresolved = new Set<string>();
        const vEval = analyzer.evaluateNode(
          cand.locatorExprNode,
          variantScope,
          checkUnresolved
        );
        if (vEval?.kind === 'locator' && checkUnresolved.size === 0) {
          variants.push({
            id: callRec.callerName,
            label: callRec.callerName,
            description: vEval.descriptor.humanReadable,
            parameters: paramsObj,
            descriptor: vEval.descriptor,
          });
        }
      }

      if (variants.length === 0 && parameterNames.length === 1) {
        const singleParam = parameterNames[0];
        const classInst =
          analyzer.getClassInstanceForNode(callable) ||
          analyzer.getPrimaryClassInstance();
        if (classInst) {
          const stringArrays = collectStringArraysFromClassProps(classInst.props);
          for (const arrItem of stringArrays) {
            for (const strVal of arrItem.values) {
              const variantScope = cloneEnv(evalEnv);
              variantScope.vars.set(singleParam, {
                kind: 'primitive',
                value: strVal,
              });
              const checkUnresolved = new Set<string>();
              const vEval = analyzer.evaluateNode(
                cand.locatorExprNode,
                variantScope,
                checkUnresolved
              );
              if (vEval?.kind === 'locator' && checkUnresolved.size === 0) {
                variants.push({
                  id: `${arrItem.path}:${strVal}`,
                  label: `${singleParam} = "${strVal}"`,
                  description: arrItem.path,
                  parameters: { [singleParam]: strVal },
                  descriptor: vEval.descriptor,
                });
              }
            }
          }
        }
      }
    }

    return {
      expressionText,
      range,
      strippedActionMethod: cand.strippedActionMethod,
      descriptor: variants[0]?.descriptor,
      requiresParameterSelection: true,
      parameterNames,
      variants,
    };
  };

  // Проходим стейтменты сниппета с конца к началу и ищем целевой локатор
  for (let i = snippetSf.statements.length - 1; i >= 0; i--) {
    const stmt = snippetSf.statements[i];

    // 1. ExpressionStatement: выражение, присваивание или вызов действия/expect
    if (ts.isExpressionStatement(stmt)) {
      const expr = unwrapParensAndTypes(stmt.expression);
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const { coreNode, strippedActionMethod } = unwrapActionAndExpectNode(
          expr.right
        );
        const res = buildResolvedResult({
          locatorExprNode: coreNode,
          strippedActionMethod,
        });
        if (res) {
          return res;
        }
      } else {
        const { coreNode, strippedActionMethod } = unwrapActionAndExpectNode(expr);
        const res = buildResolvedResult({
          locatorExprNode: coreNode,
          strippedActionMethod,
        });
        if (res) {
          return res;
        }
      }
    }

    // 2. VariableStatement: const profileRoot = ... или const fieldInputByLabel = (labelText) => ...
    if (ts.isVariableStatement(stmt)) {
      const decls = stmt.declarationList.declarations;
      for (let d = decls.length - 1; d >= 0; d--) {
        const decl = decls[d];
        if (!decl.initializer) {
          continue;
        }
        if (
          ts.isArrowFunction(decl.initializer) ||
          ts.isFunctionExpression(decl.initializer)
        ) {
          const fnNode = decl.initializer;
          const bodyExpr = !ts.isBlock(fnNode.body)
            ? fnNode.body
            : fnNode.body.statements.find(ts.isReturnStatement)?.expression;
          if (bodyExpr) {
            const { coreNode, strippedActionMethod } =
              unwrapActionAndExpectNode(bodyExpr);
            const res = buildResolvedResult({
              locatorExprNode: coreNode,
              strippedActionMethod,
              callable: fnNode,
            });
            if (res) {
              return res;
            }
          }
        }
        const { coreNode, strippedActionMethod } = unwrapActionAndExpectNode(
          decl.initializer
        );
        const res = buildResolvedResult({
          locatorExprNode: coreNode,
          strippedActionMethod,
        });
        if (res) {
          return res;
        }
      }
    }

    // 3. ReturnStatement или FunctionDeclaration (например, вставленный метод getDeliverySwitch(label: string): Locator { return ... })
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      const retStmt = stmt.body.statements.find(ts.isReturnStatement);
      if (retStmt?.expression) {
        const { coreNode, strippedActionMethod } = unwrapActionAndExpectNode(
          retStmt.expression
        );
        const res = buildResolvedResult({
          locatorExprNode: coreNode,
          strippedActionMethod,
          callable: stmt,
        });
        if (res) {
          return res;
        }
      }
    }

    if (ts.isReturnStatement(stmt) && stmt.expression) {
      const { coreNode, strippedActionMethod } = unwrapActionAndExpectNode(
        stmt.expression
      );
      const res = buildResolvedResult({
        locatorExprNode: coreNode,
        strippedActionMethod,
      });
      if (res) {
        return res;
      }
    }

    // 4. Обход вложенных узлов стейтмента (например, this.faq = { title: ... } или assertElementTag(this.mainPageTitle, 'H1'))
    const nestedCandidates: Array<{
      cand: SnippetCandidate;
      span: number;
    }> = [];

    const visitNested = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node)) {
        const { coreNode, strippedActionMethod } = unwrapActionAndExpectNode(
          node.initializer
        );
        const res = buildResolvedResult({
          locatorExprNode: coreNode,
          strippedActionMethod,
        });
        if (res) {
          nestedCandidates.push({
            cand: { locatorExprNode: coreNode, strippedActionMethod },
            span: coreNode.getEnd() - coreNode.getStart(snippetSf),
          });
          return;
        }
      } else if (
        (ts.isCallExpression(node) ||
          ts.isPropertyAccessExpression(node) ||
          ts.isIdentifier(node)) &&
        !isParentContinuingLocatorChain(node)
      ) {
        const { coreNode, strippedActionMethod } = unwrapActionAndExpectNode(node);
        const res = buildResolvedResult({
          locatorExprNode: coreNode,
          strippedActionMethod,
        });
        if (res) {
          nestedCandidates.push({
            cand: { locatorExprNode: coreNode, strippedActionMethod },
            span: node.getEnd() - node.getStart(snippetSf),
          });
          return;
        }
      }
      ts.forEachChild(node, visitNested);
    };

    visitNested(stmt);
    if (nestedCandidates.length > 0) {
      nestedCandidates.sort((a, b) => b.span - a.span);
      const best = buildResolvedResult(nestedCandidates[0].cand);
      if (best) {
        return best;
      }
    }
  }

  return undefined;
}

/**
 * Резолвит локатор из произвольного текстового сниппета, вставленного в поле поиска браузера:
 * - поддерживает прямые выражения Playwright (с page. / this.page. или без префикса: getByTestId('...'), .locator('...'));
 * - поддерживает выражения из Page Object / тестов (присваивания, const ..., this.*, локальные переменные конструктора,
 *   хелперы fieldInputByLabel(...), импортированные константы, дочерние компоненты this.mainBannerComponent.*);
 * - безопасно отрезает терминальные действия (.click(), .fill() и т.д.) и обёртки expect(...).toBeVisible();
 * - обрабатывает чистые CSS/XPath селекторы строкой без вызовов методов как page.locator(snippet).
 */
export function resolveLocatorFromSnippet(
  options: ResolveLocatorSnippetOptions
): ResolvedLocatorResult {
  const rawSnippet = options.snippet.trim();
  if (!rawSnippet) {
    throw new Error('Enter a Playwright locator expression to search.');
  }

  const normalizedSnippet = normalizeLocatorSnippetText(rawSnippet);

  const primaryFilePath =
    options.contextFilePath &&
    (options.contextSourceText !== undefined || fs.existsSync(options.contextFilePath))
      ? path.resolve(options.contextFilePath)
      : undefined;

  if (primaryFilePath) {
    const primarySource =
      options.contextSourceText !== undefined
        ? options.contextSourceText
        : fs.readFileSync(primaryFilePath, 'utf8');
    const primaryAnalyzer = new FileLocatorAnalyzer(primaryFilePath, primarySource);
    const primaryResult = tryResolveSnippetWithAnalyzer(
      normalizedSnippet,
      rawSnippet,
      primaryAnalyzer,
      options.cursorLine,
      options.parameterOverrides
    );
    if (primaryResult) {
      return primaryResult;
    }
  } else {
    const dummyPath = path.resolve(
      options.contextFilePath || path.join(process.cwd(), '__snippet_context__.ts')
    );
    const defaultAnalyzer = new FileLocatorAnalyzer(
      dummyPath,
      options.contextSourceText || ''
    );
    const defaultResult = tryResolveSnippetWithAnalyzer(
      normalizedSnippet,
      rawSnippet,
      defaultAnalyzer,
      options.cursorLine,
      options.parameterOverrides
    );
    if (defaultResult) {
      return defaultResult;
    }
  }

  // Если в текущем файле символ this.* или переменная не найдены — проверяем подходящие Page Object в проекте
  const fallbackFiles = findFallbackContextFilesForSnippet(
    normalizedSnippet,
    options.contextFilePath
  );
  for (const fallbackFile of fallbackFiles) {
    try {
      const code = fs.readFileSync(fallbackFile, 'utf8');
      const fallbackAnalyzer = new FileLocatorAnalyzer(fallbackFile, code);
      const res = tryResolveSnippetWithAnalyzer(
        normalizedSnippet,
        rawSnippet,
        fallbackAnalyzer,
        undefined,
        options.parameterOverrides
      );
      if (res) {
        return res;
      }
    } catch {
      // ignore
    }
  }

  // Проверяем, не вставлен ли чистый CSS / XPath селектор строкой без вызовов методов
  const pureSelector = extractPureSelectorString(rawSnippet);
  if (pureSelector) {
    const steps: LocatorStep[] = [
      {
        method: 'locator',
        args: [pureSelector],
      },
    ];
    const descriptor: LocatorDescriptor = {
      steps,
      humanReadable: formatLocatorSteps(steps),
    };
    return {
      expressionText: rawSnippet,
      range: {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: rawSnippet.length + 1,
      },
      descriptor,
      requiresParameterSelection: false,
      parameterNames: [],
      variants: [],
    };
  }

  throw new Error(
    `Failed to parse or resolve Playwright locator from expression: ${rawSnippet}`
  );
}

export interface CollectedFileLocator {
  /** 1-based номер строки начала локатора */
  line: number;
  /** 1-based номер колонки */
  column: number;
  expressionText: string;
  descriptor?: LocatorDescriptor;
  requiresParameterSelection: boolean;
  variantKind?: 'parameter' | 'context';
  variants: LocatorVariant[];
}

/**
 * Собирает все верхнеуровневые определения и вызовы Playwright Locator в одном файле
 * для фоновой оценки и отображения счётчиков совпадений в gutter редактора.
 */
export function collectFileLocators(options: {
  filePath: string;
  sourceText?: string;
}): CollectedFileLocator[] {
  const filePath = path.resolve(options.filePath);
  const sourceText =
    options.sourceText !== undefined
      ? options.sourceText
      : fs.readFileSync(filePath, 'utf8');

  const analyzer = new FileLocatorAnalyzer(filePath, sourceText);
  const sf = analyzer.getSourceFile();
  const parseDiagnostics: readonly ts.Diagnostic[] =
    (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics || [];

  const hasParseErrorInNode = (node: ts.Node): boolean => {
    if (parseDiagnostics.length === 0) {
      return false;
    }
    const start = node.getStart(sf);
    const end = node.getEnd();
    return parseDiagnostics.some((diag) => {
      const dStart = diag.start ?? 0;
      const dEnd = dStart + (diag.length ?? 0);
      return dStart <= end && dEnd >= start;
    });
  };

  const canEvaluateToLocator = (exprNode: ts.Node): boolean => {
    if (hasParseErrorInNode(exprNode)) {
      return false;
    }
    const scope = analyzer.findScopeForNode(exprNode);
    const enclosingCallable = findEnclosingParameterizedCallable(exprNode);
    if (enclosingCallable) {
      for (const param of enclosingCallable.parameters) {
        if (ts.isIdentifier(param.name) && !scope.vars.has(param.name.text)) {
          scope.vars.set(param.name.text, {
            kind: 'unresolvedParam',
            paramName: param.name.text,
          });
        }
      }
    }
    const testUnresolved = new Set<string>();
    const val = analyzer.evaluateNode(exprNode, scope, testUnresolved);
    return val?.kind === 'locator';
  };

  const candidates: CandidateLocatorNode[] = [];

  const visit = (node: ts.Node): void => {
    // 1) Присваивание в конструкторе: this.contentRoot = <locator>
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      canEvaluateToLocator(node.right)
    ) {
      candidates.push({
        locatorExprNode: node.right,
        hitRangeNode: node,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
      return;
    }

    // 2) Инициализированное поле класса: readonly saveBtn = this.page.getByTestId('save');
    if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      canEvaluateToLocator(node.initializer)
    ) {
      candidates.push({
        locatorExprNode: node.initializer,
        hitRangeNode: node,
      });
      return;
    }

    // 3) Переменная-локатор или стрелочная фабрика
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (canEvaluateToLocator(node.initializer)) {
        candidates.push({
          locatorExprNode: node.initializer,
          hitRangeNode: node,
          enclosingParamCallable: findEnclosingParameterizedCallable(node),
        });
        return;
      }
      if (
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer)) &&
        node.initializer.parameters.length > 0
      ) {
        const fnNode = node.initializer;
        const bodyExpr = !ts.isBlock(fnNode.body)
          ? fnNode.body
          : fnNode.body.statements.find(ts.isReturnStatement)?.expression;
        if (bodyExpr && canEvaluateToLocator(bodyExpr)) {
          candidates.push({
            locatorExprNode: bodyExpr,
            hitRangeNode:
              node.parent?.parent && ts.isVariableStatement(node.parent.parent)
                ? node.parent.parent
                : node,
            enclosingParamCallable: fnNode,
          });
          return;
        }
      }
    }

    // 4) Параметризованный метод класса, возвращающий локатор (не async)
    if (
      ts.isMethodDeclaration(node) &&
      node.body &&
      node.parameters.length > 0 &&
      !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      const retStmt = node.body.statements.find(ts.isReturnStatement);
      if (
        retStmt?.expression &&
        !ts.isAwaitExpression(retStmt.expression) &&
        !findOuterActionCall(retStmt.expression).actionMethod &&
        canEvaluateToLocator(retStmt.expression)
      ) {
        candidates.push({
          locatorExprNode: retStmt.expression,
          hitRangeNode: node,
          enclosingParamCallable: node,
        });
        return;
      }
    }

    // 5) Свойство в объекте секции: root: profileRoot, title: deliveryRoot.getByText(...)
    if (ts.isPropertyAssignment(node) && canEvaluateToLocator(node.initializer)) {
      candidates.push({
        locatorExprNode: node.initializer,
        hitRangeNode: node,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
      return;
    }

    if (ts.isShorthandPropertyAssignment(node) && canEvaluateToLocator(node.name)) {
      candidates.push({
        locatorExprNode: node.name,
        hitRangeNode: node,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
      return;
    }

    // 6) Самостоятельное выражение локатора / действие (.click(), expect(...))
    if (
      (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) &&
      !isParentContinuingLocatorChain(node) &&
      canEvaluateToLocator(node)
    ) {
      const { actionMethod, fullCallNode } = findOuterActionCall(node);
      candidates.push({
        locatorExprNode: node,
        hitRangeNode: fullCallNode,
        strippedActionMethod: actionMethod,
        enclosingParamCallable: findEnclosingParameterizedCallable(node),
      });
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  const byLine = new Map<number, CollectedFileLocator>();
  for (const cand of candidates) {
    if (hasParseErrorInNode(cand.hitRangeNode)) {
      continue;
    }
    try {
      const resolved = buildResultFromCandidate(cand, analyzer, sf);
      const line = resolved.range.startLine;
      if (byLine.has(line)) {
        continue;
      }
      if (
        !resolved.descriptor &&
        (!resolved.requiresParameterSelection || resolved.variants.length === 0)
      ) {
        continue;
      }
      const exprPos = sf.getLineAndCharacterOfPosition(
        cand.locatorExprNode.getStart(sf)
      );
      byLine.set(line, {
        line,
        column: exprPos.character + 1,
        expressionText: resolved.expressionText,
        descriptor: resolved.descriptor,
        requiresParameterSelection: resolved.requiresParameterSelection,
        variantKind: resolved.variantKind,
        variants: resolved.variants,
      });
    } catch {
      // Игнорируем невычислимые/недописанные узлы при живом редактировании
    }
  }

  return Array.from(byLine.values()).sort((a, b) => a.line - b.line);
}
