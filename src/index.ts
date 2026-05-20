import type * as tslib from "typescript/lib/tsserverlibrary";

function init(modules: { typescript: typeof tslib }) {
    const ts = modules.typescript;

    function create(info: tslib.server.PluginCreateInfo): tslib.LanguageService {
        const ls = info.languageService;
        const log = (msg: string) =>
            info.project.projectService.logger.info(`[cocos-ts-plugin] ${msg}`);

        log("plugin loaded v0.3.0");

        let cachedIndex: { program: tslib.Program; extend: ExtendIndex; expando: ExpandoIndex } | undefined;

        const getExtendIndexNow = (): ExtendIndex => {
            ensureIndex();
            return cachedIndex!.extend;
        };
        const getExpandoIndex = (): ExpandoIndex => {
            ensureIndex();
            return cachedIndex!.expando;
        };

        function ensureIndex(): void {
            const program = ls.getProgram();
            if (!program) {
                cachedIndex = { program: program!, extend: new Map(), expando: new Map() };
                return;
            }
            if (cachedIndex && cachedIndex.program === program) return;
            const started = Date.now();
            const { extend, expando } = buildIndices(ts, program);
            log(`indices built: ${extend.size} extend classes, ${expando.size} expando paths, ${Date.now() - started}ms`);
            cachedIndex = { program, extend, expando };
        }

        const guard = <T>(name: string, fn: () => T, fallback: T): T => {
            try {
                return fn();
            } catch (e: any) {
                log(`error in ${name}: ${e && e.stack ? e.stack : e}`);
                return fallback;
            }
        };

        const proxy: tslib.LanguageService = Object.create(null);
        for (const k of Object.keys(ls) as Array<keyof tslib.LanguageService>) {
            const fn = ls[k] as any;
            proxy[k] = (...args: any[]) => fn.apply(ls, args);
        }

        proxy.getDefinitionAndBoundSpan = (fileName, position) =>
            guard("getDefinitionAndBoundSpan", () => {
                const original = ls.getDefinitionAndBoundSpan(fileName, position);
                if (original && original.definitions && original.definitions.length > 0) {
                    return original;
                }
                const ctx = locateThisMember(ts, ls, getExtendIndexNow, fileName, position)
                    ?? locateChainedMember(ts, ls, getExtendIndexNow, fileName, position);
                if (ctx) {
                    log(`def: resolved ${ctx.memberName} -> ${ctx.propertySourceFile.fileName}:${ctx.propertyNameNode.getStart(ctx.propertySourceFile)}`);
                    return buildDefinition(ts, ctx);
                }
                const dotted = locateDottedAccess(ts, ls, getExpandoIndex, fileName, position);
                if (dotted) {
                    log(`def: resolved ${dotted.fullName} -> ${dotted.entry.sourceFile.fileName}:${dotted.entry.nameNode.getStart(dotted.entry.sourceFile)}`);
                    return buildDefinitionFromExpando(ts, dotted);
                }
                log(`def: no context at ${fileName}:${position}`);
                return original;
            }, ls.getDefinitionAndBoundSpan(fileName, position));

        proxy.getDefinitionAtPosition = (fileName, position) =>
            guard("getDefinitionAtPosition", () => {
                const original = ls.getDefinitionAtPosition(fileName, position);
                if (original && original.length > 0) return original;
                const ctx = locateThisMember(ts, ls, getExtendIndexNow, fileName, position)
                    ?? locateChainedMember(ts, ls, getExtendIndexNow, fileName, position);
                if (ctx) {
                    return buildDefinition(ts, ctx).definitions as tslib.DefinitionInfo[];
                }
                const dotted = locateDottedAccess(ts, ls, getExpandoIndex, fileName, position);
                if (dotted) {
                    return buildDefinitionFromExpando(ts, dotted).definitions as tslib.DefinitionInfo[];
                }
                return undefined;
            }, ls.getDefinitionAtPosition(fileName, position));

        proxy.getQuickInfoAtPosition = (fileName, position) =>
            guard("getQuickInfoAtPosition", () => {
                const original = ls.getQuickInfoAtPosition(fileName, position);
                if (original && !isAnyQuickInfo(ts, original)) return original;
                const ctx = locateThisMember(ts, ls, getExtendIndexNow, fileName, position)
                    ?? locateChainedMember(ts, ls, getExtendIndexNow, fileName, position);
                if (ctx) {
                    log(`hover: resolving ${ctx.memberName}`);
                    return buildQuickInfo(ts, ls, ctx) ?? original;
                }
                const dotted = locateDottedAccess(ts, ls, getExpandoIndex, fileName, position);
                if (dotted) {
                    log(`hover: resolving ${dotted.fullName}`);
                    return buildQuickInfoFromExpando(ts, ls, dotted) ?? original;
                }
                return original;
            }, ls.getQuickInfoAtPosition(fileName, position));

        proxy.findReferences = (fileName, position) =>
            guard("findReferences", () => {
                const original = ls.findReferences(fileName, position);
                const memberCtx = resolveExtendMember(ts, ls, fileName, position);
                if (!memberCtx) {
                    log(`refs: no extend-member context at ${fileName}:${position}`);
                    return original;
                }
                const extra = scanExtendReferences(ts, ls, memberCtx.memberName);
                log(`refs: ${memberCtx.memberName} -> tsserver=${original?.reduce((n, s) => n + s.references.length, 0) ?? 0}, scanned=${extra.length}`);
                return mergeReferences(ts, original, extra, memberCtx);
            }, ls.findReferences(fileName, position));

        proxy.getCompletionsAtPosition = (fileName, position, options, formatOptions) =>
            guard("getCompletionsAtPosition", () => {
                const original = ls.getCompletionsAtPosition(fileName, position, options, formatOptions);
                const extras = collectMemberCompletions(
                    ts, ls, getExtendIndexNow, getExpandoIndex, fileName, position
                );
                if (extras.length === 0) return original;
                if (!original) {
                    return {
                        isGlobalCompletion: false,
                        isMemberCompletion: true,
                        isNewIdentifierLocation: false,
                        entries: extras,
                    };
                }
                // Replace tsserver's low-confidence "warning" entries with ours when
                // names collide, append the rest.
                const indexByName = new Map<string, number>();
                original.entries.forEach((e, i) => indexByName.set(e.name, i));
                for (const extra of extras) {
                    const idx = indexByName.get(extra.name);
                    if (idx === undefined) {
                        original.entries.push(extra);
                        indexByName.set(extra.name, original.entries.length - 1);
                    } else if (original.entries[idx].kind === ts.ScriptElementKind.warning) {
                        original.entries[idx] = extra;
                    }
                }
                return original;
            }, ls.getCompletionsAtPosition(fileName, position, options, formatOptions));

        proxy.getReferencesAtPosition = (fileName, position) =>
            guard("getReferencesAtPosition", () => {
                const original = ls.getReferencesAtPosition(fileName, position) ?? [];
                const memberCtx = resolveExtendMember(ts, ls, fileName, position);
                if (!memberCtx) return original.length ? original : undefined;
                const extra = scanExtendReferences(ts, ls, memberCtx.memberName);
                return dedupeReferences([...original, ...extra]);
            }, ls.getReferencesAtPosition(fileName, position));

        return proxy;
    }

    return { create };
}

interface ThisMemberContext {
    sourceFile: tslib.SourceFile;
    identifier: tslib.Identifier;
    memberName: string;
    property: tslib.ObjectLiteralElementLike;
    propertyNameNode: tslib.Node;
    /** Where `property` lives — same as `sourceFile` for own members, different for inherited. */
    propertySourceFile: tslib.SourceFile;
}

interface ExtendMemberContext {
    sourceFile: tslib.SourceFile;
    memberName: string;
    identifier: tslib.Identifier;
}

interface ExtendEntry {
    className: string;
    parentName: string | undefined;
    literal: tslib.ObjectLiteralExpression;
    sourceFile: tslib.SourceFile;
}

type ExtendIndex = Map<string, ExtendEntry[]>;

interface ExpandoEntry {
    fullName: string;                 // e.g., "ccui.Widget.TOUCH_ENDED"
    nameNode: tslib.Node;             // the `.name` part of the LHS PropertyAccess
    initializer: tslib.Expression;    // the RHS expression
    sourceFile: tslib.SourceFile;
}

type ExpandoIndex = Map<string, ExpandoEntry[]>;

function buildIndices(
    ts: typeof tslib,
    program: tslib.Program
): { extend: ExtendIndex; expando: ExpandoIndex } {
    const extend: ExtendIndex = new Map();
    const expando: ExpandoIndex = new Map();
    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        collectEntries(ts, sf, extend, expando);
    }
    return { extend, expando };
}

function collectEntries(
    ts: typeof tslib,
    sf: tslib.SourceFile,
    extendIndex: ExtendIndex,
    expandoIndex: ExpandoIndex
): void {
    function visit(node: tslib.Node): void {
        // let/var/const <name> = <expr>.extend({...})
        if (ts.isVariableDeclaration(node) && node.initializer && isExtendCallWithLiteral(ts, node.initializer)) {
            if (ts.isIdentifier(node.name)) {
                addToIndex(extendIndex, node.name.text, makeEntry(ts, node.name.text, node.initializer, sf));
            }
        }
        // <LHS> = <RHS>
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const lhsName = expressionToName(ts, node.left);
            if (lhsName) {
                if (isExtendCallWithLiteral(ts, node.right)) {
                    // X = Y.extend({...})  -> extend entry
                    addToIndex(extendIndex, lhsName, makeEntry(ts, lhsName, node.right, sf));
                } else if (ts.isPropertyAccessExpression(node.left) && lhsName.includes(".")) {
                    // a.b.c = anything  -> expando entry (only when LHS is a dotted property access)
                    addToIndex(expandoIndex, lhsName, {
                        fullName: lhsName,
                        nameNode: node.left.name,
                        initializer: node.right,
                        sourceFile: sf,
                    });
                    // a.b = { foo: function(){...}, ... }  -> index each nested member as a.b.foo
                    // (covers the cocos2d-x auto-api stub pattern in jsb_*_auto_api.js)
                    if (ts.isObjectLiteralExpression(node.right)) {
                        for (const prop of node.right.properties) {
                            const propName = getPropertyName(ts, prop);
                            const propNameNode = (prop as any).name as tslib.Node | undefined;
                            if (!propName || !propNameNode) continue;
                            const init = ts.isPropertyAssignment(prop)
                                ? prop.initializer
                                : ts.isMethodDeclaration(prop)
                                ? (prop as unknown as tslib.Expression)
                                : undefined;
                            if (!init) continue;
                            const nestedKey = `${lhsName}.${propName}`;
                            addToIndex(expandoIndex, nestedKey, {
                                fullName: nestedKey,
                                nameNode: propNameNode,
                                initializer: init,
                                sourceFile: sf,
                            });
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
}

function isExtendCallWithLiteral(
    ts: typeof tslib,
    node: tslib.Expression
): node is tslib.CallExpression {
    return (
        ts.isCallExpression(node) &&
        isExtendCall(ts, node) &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0])
    );
}

function makeEntry(
    ts: typeof tslib,
    className: string,
    callExpr: tslib.CallExpression,
    sf: tslib.SourceFile
): ExtendEntry {
    const parentExpr = (callExpr.expression as tslib.PropertyAccessExpression).expression;
    return {
        className,
        parentName: expressionToName(ts, parentExpr),
        literal: callExpr.arguments[0] as tslib.ObjectLiteralExpression,
        sourceFile: sf,
    };
}

function addToIndex<T>(index: Map<string, T[]>, key: string, entry: T): void {
    let arr = index.get(key);
    if (!arr) {
        arr = [];
        index.set(key, arr);
    }
    arr.push(entry);
}

function expressionToName(ts: typeof tslib, node: tslib.Node): string | undefined {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
        const parent = expressionToName(ts, node.expression);
        return parent ? `${parent}.${node.name.text}` : undefined;
    }
    return undefined;
}

function locateThisMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getIndex: () => ExtendIndex,
    fileName: string,
    position: number
): ThisMemberContext | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return undefined;

    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node || !ts.isIdentifier(node)) return undefined;

    const parent = node.parent;
    if (!parent || !ts.isPropertyAccessExpression(parent)) return undefined;
    if (parent.name !== node) return undefined;
    if (parent.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;

    const literal = findEnclosingExtendLiteral(ts, parent);
    if (!literal) return undefined;

    const memberName = node.text;
    const hit = lookupInLiteralAndChain(ts, getIndex, literal, memberName);
    if (!hit) return undefined;
    return makeContext(sourceFile, node, memberName, hit.property, hit.propertySourceFile);
}

/**
 * Resolves `this.member.<sub>` and `<DottedClass>.<sub>` (where the receiver expression
 * names a class in the extend index, possibly via a project type-hint convention like
 * `m_layout: ccui.layout`). Walks the resolved class's extend chain to find `<sub>`.
 */
function locateChainedMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getIndex: () => ExtendIndex,
    fileName: string,
    position: number
): ThisMemberContext | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return undefined;

    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node || !ts.isIdentifier(node)) return undefined;

    const parent = node.parent;
    if (!parent || !ts.isPropertyAccessExpression(parent)) return undefined;
    if (parent.name !== node) return undefined;

    const receiver = parent.expression;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return undefined; // handled by locateThisMember

    const className = resolveReceiverToClass(ts, getIndex, receiver);
    if (!className) return undefined;

    const memberName = node.text;
    const entries = getIndex().get(className);
    if (!entries || entries.length === 0) return undefined;
    for (const entry of entries) {
        const hit = lookupInLiteralAndChain(ts, getIndex, entry.literal, memberName);
        if (hit) {
            return makeContext(sourceFile, node, memberName, hit.property, hit.propertySourceFile);
        }
    }
    return undefined;
}

function resolveReceiverToClass(
    ts: typeof tslib,
    getIndex: () => ExtendIndex,
    receiver: tslib.Expression
): string | undefined {
    // Case A: `this.<member>` — read the type hint from `member`'s initializer in the
    // enclosing extend literal (and its parent chain).
    if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        const literal = findEnclosingExtendLiteral(ts, receiver);
        if (!literal) return undefined;
        const hit = lookupInLiteralAndChain(ts, getIndex, literal, receiver.name.text);
        if (!hit) return undefined;
        const prop = hit.property;
        const init = ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
        if (!init) return undefined;
        const hintName = expressionToName(ts, init);
        if (!hintName) return undefined;
        return lookupClassName(getIndex(), hintName);
    }
    // Case B: receiver is a dotted name that matches a known class directly.
    const direct = expressionToName(ts, receiver);
    if (direct) {
        const found = lookupClassName(getIndex(), direct);
        if (found) return found;
    }
    return undefined;
}

/**
 * Looks up a class name in the index, trying the exact name first, then a fallback
 * with the last segment capitalized (handles project type-hint conventions like
 * `m_layout: ccui.layout` where the convention writes the namespace lowercased but
 * the real class definition is `ccui.Layout`).
 */
function lookupClassName(index: ExtendIndex, name: string): string | undefined {
    if (index.has(name)) return name;
    const dot = name.lastIndexOf(".");
    if (dot < 0) {
        const cap = name[0]?.toUpperCase() + name.slice(1);
        return index.has(cap) ? cap : undefined;
    }
    const head = name.substring(0, dot + 1);
    const tail = name.substring(dot + 1);
    if (!tail) return undefined;
    const cap = head + tail[0].toUpperCase() + tail.slice(1);
    return index.has(cap) ? cap : undefined;
}

interface LiteralHit {
    property: tslib.ObjectLiteralElementLike;
    propertySourceFile: tslib.SourceFile;
}

/**
 * Searches `literal` for a property named `memberName`. If not found, walks up the
 * extend chain (via the literal's owner's parentName, looked up in the index).
 */
function lookupInLiteralAndChain(
    ts: typeof tslib,
    getIndex: () => ExtendIndex,
    literal: tslib.ObjectLiteralExpression,
    memberName: string
): LiteralHit | undefined {
    const direct = findPropertyByName(ts, literal, memberName);
    if (direct) {
        return { property: direct, propertySourceFile: literal.getSourceFile() };
    }
    const owner = getLiteralOwner(ts, literal);
    if (!owner || !owner.parentName) return undefined;
    return walkChain(ts, getIndex, owner.parentName, memberName);
}

function walkChain(
    ts: typeof tslib,
    getIndex: () => ExtendIndex,
    startParent: string,
    memberName: string
): LiteralHit | undefined {
    const index = getIndex();
    const seen = new Set<string>();
    let parentName: string | undefined = startParent;
    while (parentName && !seen.has(parentName)) {
        seen.add(parentName);
        const entries = index.get(parentName);
        if (!entries || entries.length === 0) return undefined;
        for (const entry of entries) {
            const prop = findPropertyByName(ts, entry.literal, memberName);
            if (prop) {
                return { property: prop, propertySourceFile: entry.sourceFile };
            }
        }
        parentName = entries[0].parentName;
    }
    return undefined;
}

function makeContext(
    sourceFile: tslib.SourceFile,
    identifier: tslib.Identifier,
    memberName: string,
    property: tslib.ObjectLiteralElementLike,
    propertySourceFile: tslib.SourceFile
): ThisMemberContext {
    const propertyNameNode = (property as any).name ?? property;
    return {
        sourceFile,
        identifier,
        memberName,
        property,
        propertyNameNode,
        propertySourceFile,
    };
}

function getLiteralOwner(
    ts: typeof tslib,
    literal: tslib.ObjectLiteralExpression
): { className: string; parentName: string | undefined } | undefined {
    const callExpr = literal.parent;
    if (!callExpr || !ts.isCallExpression(callExpr)) return undefined;

    const callParent = callExpr.parent;
    if (!callParent) return undefined;

    let lhsExpr: tslib.Node | undefined;
    if (ts.isVariableDeclaration(callParent) && callParent.initializer === callExpr) {
        if (!ts.isIdentifier(callParent.name)) return undefined;
        lhsExpr = callParent.name;
    } else if (
        ts.isBinaryExpression(callParent) &&
        callParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        callParent.right === callExpr
    ) {
        lhsExpr = callParent.left;
    } else {
        return undefined;
    }

    const className = expressionToName(ts, lhsExpr);
    if (!className) return undefined;

    const parentExpr = (callExpr.expression as tslib.PropertyAccessExpression).expression;
    return { className, parentName: expressionToName(ts, parentExpr) };
}

/**
 * Detect when the cursor is on a member name inside an extend literal — either:
 *   1. `this.xxx` access expression's `xxx` identifier, or
 *   2. `xxx:` property name in an extend literal
 */
function resolveExtendMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    fileName: string,
    position: number
): ExtendMemberContext | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return undefined;

    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node || !ts.isIdentifier(node)) return undefined;

    const parent = node.parent;
    if (!parent) return undefined;

    if (
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        parent.expression.kind === ts.SyntaxKind.ThisKeyword &&
        findEnclosingExtendLiteral(ts, parent)
    ) {
        return { sourceFile, memberName: node.text, identifier: node };
    }

    if (
        (ts.isPropertyAssignment(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isShorthandPropertyAssignment(parent)) &&
        (parent as any).name === node
    ) {
        const literalNode = parent.parent;
        if (
            literalNode &&
            ts.isObjectLiteralExpression(literalNode) &&
            literalNode.parent &&
            ts.isCallExpression(literalNode.parent) &&
            literalNode.parent.arguments[0] === literalNode &&
            isExtendCall(ts, literalNode.parent)
        ) {
            return { sourceFile, memberName: node.text, identifier: node };
        }
    }

    return undefined;
}

function findEnclosingExtendLiteral(
    ts: typeof tslib,
    start: tslib.Node
): tslib.ObjectLiteralExpression | undefined {
    let cur: tslib.Node | undefined = start.parent;
    while (cur) {
        if (
            ts.isObjectLiteralExpression(cur) &&
            cur.parent &&
            ts.isCallExpression(cur.parent) &&
            cur.parent.arguments[0] === cur &&
            isExtendCall(ts, cur.parent)
        ) {
            return cur;
        }
        cur = cur.parent;
    }
    return undefined;
}

interface DottedAccessHit {
    sourceFile: tslib.SourceFile;
    identifier: tslib.Identifier;
    fullName: string;
    entry: ExpandoEntry;
}

function locateDottedAccess(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getIndex: () => ExpandoIndex,
    fileName: string,
    position: number
): DottedAccessHit | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return undefined;

    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node || !ts.isIdentifier(node)) return undefined;

    const parent = node.parent;
    if (!parent || !ts.isPropertyAccessExpression(parent)) return undefined;
    if (parent.name !== node) return undefined;
    // Exclude `this.xxx` — handled elsewhere.
    if (parent.expression.kind === ts.SyntaxKind.ThisKeyword) return undefined;

    const fullName = expressionToName(ts, parent);
    if (!fullName || !fullName.includes(".")) return undefined;

    const entries = getIndex().get(fullName);
    if (!entries || entries.length === 0) return undefined;

    return { sourceFile, identifier: node, fullName, entry: entries[0] };
}

function buildDefinitionFromExpando(
    ts: typeof tslib,
    hit: DottedAccessHit
): tslib.DefinitionInfoAndBoundSpan {
    const { sourceFile, identifier, fullName, entry } = hit;
    const sourceStart = identifier.getStart(sourceFile);
    const sourceLength = identifier.getEnd() - sourceStart;
    const destStart = entry.nameNode.getStart(entry.sourceFile);
    const destLength = entry.nameNode.getEnd() - destStart;
    return {
        textSpan: { start: sourceStart, length: sourceLength },
        definitions: [
            {
                fileName: entry.sourceFile.fileName,
                textSpan: { start: destStart, length: destLength },
                kind: ts.ScriptElementKind.memberVariableElement,
                name: identifier.text,
                containerName: fullName.substring(0, fullName.lastIndexOf(".")),
                containerKind: ts.ScriptElementKind.classElement,
            } as tslib.DefinitionInfo,
        ],
    };
}

function buildQuickInfoFromExpando(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    hit: DottedAccessHit
): tslib.QuickInfo | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const checker = program.getTypeChecker();

    const { sourceFile, identifier, fullName, entry } = hit;
    const sourceStart = identifier.getStart(sourceFile);
    const sourceLength = identifier.getEnd() - sourceStart;

    let label = "(property) ";
    let typeStr: string;
    let kind: tslib.ScriptElementKind = ts.ScriptElementKind.memberVariableElement;

    const init = entry.initializer;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        const sig = checker.getSignatureFromDeclaration(init);
        typeStr = sig ? checker.signatureToString(sig) : "(...args: any[]) => any";
        kind = ts.ScriptElementKind.memberFunctionElement;
        label = "(method) ";
    } else {
        const t = checker.getTypeAtLocation(init);
        typeStr = checker.typeToString(t);
    }

    return {
        kind,
        kindModifiers: "",
        textSpan: { start: sourceStart, length: sourceLength },
        displayParts: [
            { text: label, kind: "punctuation" },
            { text: fullName, kind: "propertyName" },
            { text: ": ", kind: "punctuation" },
            { text: typeStr, kind: "text" },
        ],
        documentation: [],
        tags: [],
    };
}

function collectMemberCompletions(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getExtendIndex: () => ExtendIndex,
    getExpandoIndex: () => ExpandoIndex,
    fileName: string,
    position: number
): tslib.CompletionEntry[] {
    const program = ls.getProgram();
    if (!program) return [];
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return [];

    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node) return [];

    // The cursor sits inside a PropertyAccessExpression's `.name` slot (either an
    // empty/incomplete identifier right after a `.`, or an in-progress identifier).
    let parent = node.parent;
    let access: tslib.PropertyAccessExpression | undefined;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        access = parent;
    } else if (node && ts.isPropertyAccessExpression(node)) {
        access = node;
    }
    if (!access) return [];

    const receiver = access.expression;
    const out: tslib.CompletionEntry[] = [];
    const seen = new Set<string>();
    const push = (name: string, kind: tslib.ScriptElementKind): void => {
        if (seen.has(name)) return;
        seen.add(name);
        out.push({
            name,
            kind,
            kindModifiers: "",
            sortText: "0",
        });
    };

    // 1. `this.` -> enumerate enclosing extend literal + chain
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
        const literal = findEnclosingExtendLiteral(ts, access);
        if (literal) enumerateLiteralAndChain(ts, getExtendIndex, literal, push);
        return out;
    }

    // 2. `this.<field>.` -> resolve field's type hint, enumerate that class
    if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        const className = resolveReceiverToClass(ts, getExtendIndex, receiver);
        if (className) {
            enumerateClass(ts, getExtendIndex, className, push);
        }
        return out;
    }

    // 3. Dotted name (`sp.SkeletonAnimation.`, `cc.Node.`, etc.)
    const dottedName = expressionToName(ts, receiver);
    if (dottedName) {
        // 3a. If the dotted name itself is a known class, enumerate its literal members.
        const className = lookupClassName(getExtendIndex(), dottedName);
        if (className) enumerateClass(ts, getExtendIndex, className, push);

        // 3b. Enumerate expando children: any indexed `<dottedName>.<tail>` with no
        // further dots in the tail.
        const expando = getExpandoIndex();
        const prefix = dottedName + ".";
        for (const [key, entries] of expando) {
            if (!key.startsWith(prefix)) continue;
            const tail = key.substring(prefix.length);
            if (tail.length === 0 || tail.includes(".")) continue;
            const init = entries[0]?.initializer;
            const kind =
                init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))
                    ? ts.ScriptElementKind.memberFunctionElement
                    : ts.ScriptElementKind.memberVariableElement;
            push(tail, kind);
        }
    }

    return out;
}

function enumerateLiteralAndChain(
    ts: typeof tslib,
    getIndex: () => ExtendIndex,
    literal: tslib.ObjectLiteralExpression,
    push: (name: string, kind: tslib.ScriptElementKind) => void
): void {
    for (const prop of literal.properties) {
        const n = getPropertyName(ts, prop);
        if (n) push(n, classifyPropertyKind(ts, prop));
    }
    const owner = getLiteralOwner(ts, literal);
    if (!owner || !owner.parentName) return;
    walkChainEnumerate(ts, getIndex, owner.parentName, push);
}

function enumerateClass(
    ts: typeof tslib,
    getIndex: () => ExtendIndex,
    className: string,
    push: (name: string, kind: tslib.ScriptElementKind) => void
): void {
    const entries = getIndex().get(className);
    if (!entries || entries.length === 0) return;
    for (const entry of entries) {
        for (const prop of entry.literal.properties) {
            const n = getPropertyName(ts, prop);
            if (n) push(n, classifyPropertyKind(ts, prop));
        }
    }
    if (entries[0].parentName) {
        walkChainEnumerate(ts, getIndex, entries[0].parentName, push);
    }
}

function walkChainEnumerate(
    ts: typeof tslib,
    getIndex: () => ExtendIndex,
    startParent: string,
    push: (name: string, kind: tslib.ScriptElementKind) => void
): void {
    const index = getIndex();
    const seen = new Set<string>();
    let parentName: string | undefined = startParent;
    while (parentName && !seen.has(parentName)) {
        seen.add(parentName);
        const entries = index.get(parentName);
        if (!entries || entries.length === 0) return;
        for (const entry of entries) {
            for (const prop of entry.literal.properties) {
                const n = getPropertyName(ts, prop);
                if (n) push(n, classifyPropertyKind(ts, prop));
            }
        }
        parentName = entries[0].parentName;
    }
}

function classifyPropertyKind(
    ts: typeof tslib,
    prop: tslib.ObjectLiteralElementLike
): tslib.ScriptElementKind {
    if (ts.isMethodDeclaration(prop)) return ts.ScriptElementKind.memberFunctionElement;
    if (ts.isPropertyAssignment(prop)) {
        const init = prop.initializer;
        if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
            return ts.ScriptElementKind.memberFunctionElement;
        }
    }
    return ts.ScriptElementKind.memberVariableElement;
}

function buildDefinition(
    ts: typeof tslib,
    ctx: ThisMemberContext
): tslib.DefinitionInfoAndBoundSpan {
    const { sourceFile, identifier, memberName, propertyNameNode, propertySourceFile } = ctx;
    const sourceStart = identifier.getStart(sourceFile);
    const sourceLength = identifier.getEnd() - sourceStart;
    const destStart = propertyNameNode.getStart(propertySourceFile);
    const destLength = propertyNameNode.getEnd() - destStart;

    return {
        textSpan: { start: sourceStart, length: sourceLength },
        definitions: [
            {
                fileName: propertySourceFile.fileName,
                textSpan: { start: destStart, length: destLength },
                kind: ts.ScriptElementKind.memberVariableElement,
                name: memberName,
                containerName: "",
                containerKind: ts.ScriptElementKind.classElement,
            } as tslib.DefinitionInfo,
        ],
    };
}

function buildQuickInfo(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    ctx: ThisMemberContext
): tslib.QuickInfo | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const checker = program.getTypeChecker();

    const { sourceFile, identifier, memberName, property } = ctx;

    const sourceStart = identifier.getStart(sourceFile);
    const sourceLength = identifier.getEnd() - sourceStart;

    let kind: tslib.ScriptElementKind;
    let label: string;
    let typeStr: string;

    if (ts.isMethodDeclaration(property)) {
        const sig = checker.getSignatureFromDeclaration(property);
        typeStr = sig ? checker.signatureToString(sig) : "(...args: any[]) => any";
        kind = ts.ScriptElementKind.memberFunctionElement;
        label = "(method) ";
    } else if (ts.isPropertyAssignment(property)) {
        const init = property.initializer;
        if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
            const sig = checker.getSignatureFromDeclaration(init);
            typeStr = sig ? checker.signatureToString(sig) : "(...args: any[]) => any";
            kind = ts.ScriptElementKind.memberFunctionElement;
            label = "(method) ";
        } else {
            const t = checker.getTypeAtLocation(init);
            typeStr = checker.typeToString(t);
            kind = ts.ScriptElementKind.memberVariableElement;
            label = "(property) ";
        }
    } else if (ts.isShorthandPropertyAssignment(property)) {
        const t = checker.getTypeAtLocation(property.name);
        typeStr = checker.typeToString(t);
        kind = ts.ScriptElementKind.memberVariableElement;
        label = "(property) ";
    } else {
        return undefined;
    }

    const displayParts: tslib.SymbolDisplayPart[] = [
        { text: label, kind: "punctuation" },
        { text: memberName, kind: "propertyName" },
        { text: ": ", kind: "punctuation" },
        { text: typeStr, kind: "text" },
    ];

    return {
        kind,
        kindModifiers: "",
        textSpan: { start: sourceStart, length: sourceLength },
        displayParts,
        documentation: extractJSDocAsParts(ts, property),
        tags: [],
    };
}

function scanExtendReferences(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    memberName: string
): tslib.ReferenceEntry[] {
    const program = ls.getProgram();
    if (!program) return [];

    const refs: tslib.ReferenceEntry[] = [];
    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        walkExtendLiterals(ts, sf, (literal) => {
            for (const prop of literal.properties) {
                if (getPropertyName(ts, prop) !== memberName) continue;
                const nameNode = (prop as any).name as tslib.Node | undefined;
                if (!nameNode) continue;
                const start = nameNode.getStart(sf);
                refs.push({
                    fileName: sf.fileName,
                    textSpan: { start, length: nameNode.getEnd() - start },
                    isWriteAccess: true,
                });
            }
            walkThisAccesses(ts, literal, memberName, (id) => {
                const start = id.getStart(sf);
                refs.push({
                    fileName: sf.fileName,
                    textSpan: { start, length: id.getEnd() - start },
                    isWriteAccess: isWriteAccessOfPropertyAccess(ts, id),
                });
            });
        });
    }
    return refs;
}

function isWriteAccessOfPropertyAccess(ts: typeof tslib, id: tslib.Identifier): boolean {
    const access = id.parent;
    if (!access) return false;
    const assign = access.parent;
    if (!assign) return false;
    if (ts.isBinaryExpression(assign) && assign.left === access) {
        const op = assign.operatorToken.kind;
        return (
            op === ts.SyntaxKind.EqualsToken ||
            op === ts.SyntaxKind.PlusEqualsToken ||
            op === ts.SyntaxKind.MinusEqualsToken ||
            op === ts.SyntaxKind.AsteriskEqualsToken ||
            op === ts.SyntaxKind.SlashEqualsToken
        );
    }
    return false;
}

function walkExtendLiterals(
    ts: typeof tslib,
    sourceFile: tslib.SourceFile,
    callback: (literal: tslib.ObjectLiteralExpression) => void
): void {
    function visit(node: tslib.Node): void {
        if (
            ts.isCallExpression(node) &&
            isExtendCall(ts, node) &&
            node.arguments.length > 0 &&
            ts.isObjectLiteralExpression(node.arguments[0])
        ) {
            callback(node.arguments[0] as tslib.ObjectLiteralExpression);
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

function walkThisAccesses(
    ts: typeof tslib,
    root: tslib.Node,
    name: string,
    callback: (id: tslib.Identifier) => void
): void {
    function visit(node: tslib.Node): void {
        if (
            ts.isPropertyAccessExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ThisKeyword &&
            ts.isIdentifier(node.name) &&
            node.name.text === name
        ) {
            callback(node.name);
        }
        ts.forEachChild(node, visit);
    }
    visit(root);
}

function mergeReferences(
    ts: typeof tslib,
    original: tslib.ReferencedSymbol[] | undefined,
    extra: tslib.ReferenceEntry[],
    ctx: ExtendMemberContext
): tslib.ReferencedSymbol[] | undefined {
    const seen = new Set<string>();
    const collected: tslib.ReferenceEntry[] = [];

    if (original) {
        for (const sym of original) {
            for (const ref of sym.references) {
                const key = `${ref.fileName}:${ref.textSpan.start}`;
                if (seen.has(key)) continue;
                seen.add(key);
                collected.push(ref);
            }
        }
    }
    for (const ref of extra) {
        const key = `${ref.fileName}:${ref.textSpan.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(ref);
    }

    if (collected.length === 0) return original;

    const definition: tslib.ReferencedSymbolDefinitionInfo = original && original[0]
        ? original[0].definition
        : {
              containerKind: "" as tslib.ScriptElementKind,
              containerName: "",
              fileName: ctx.sourceFile.fileName,
              kind: ts.ScriptElementKind.memberVariableElement,
              name: ctx.memberName,
              textSpan: {
                  start: ctx.identifier.getStart(ctx.sourceFile),
                  length: ctx.identifier.getEnd() - ctx.identifier.getStart(ctx.sourceFile),
              },
              displayParts: [{ text: ctx.memberName, kind: "propertyName" }],
          };

    return [{ definition, references: collected }];
}

function dedupeReferences(refs: tslib.ReferenceEntry[]): tslib.ReferenceEntry[] {
    const seen = new Set<string>();
    const out: tslib.ReferenceEntry[] = [];
    for (const r of refs) {
        const key = `${r.fileName}:${r.textSpan.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}

function extractJSDocAsParts(
    ts: typeof tslib,
    property: tslib.ObjectLiteralElementLike
): tslib.SymbolDisplayPart[] {
    const jsDocs = (ts as any).getJSDocCommentsAndTags(property) as tslib.Node[];
    if (!jsDocs || jsDocs.length === 0) return [];
    const text = jsDocs
        .map((doc) => {
            const c = (doc as any).comment;
            if (typeof c === "string") return c;
            if (Array.isArray(c)) return c.map((p: any) => p.text ?? "").join("");
            return "";
        })
        .filter((s) => s.length > 0)
        .join("\n");
    if (!text) return [];
    return [{ text, kind: "text" }];
}

function isAnyQuickInfo(ts: typeof tslib, qi: tslib.QuickInfo): boolean {
    if (!qi.displayParts) return false;
    const text = qi.displayParts.map((p) => p.text).join("");
    return /:\s*any\s*$/.test(text) || text === "any";
}

function isExtendCall(ts: typeof tslib, call: tslib.CallExpression): boolean {
    if (!ts.isPropertyAccessExpression(call.expression)) return false;
    return call.expression.name.text === "extend";
}

function findPropertyByName(
    ts: typeof tslib,
    literal: tslib.ObjectLiteralExpression,
    name: string
): tslib.ObjectLiteralElementLike | undefined {
    for (const prop of literal.properties) {
        const propName = getPropertyName(ts, prop);
        if (propName === name) return prop;
    }
    return undefined;
}

function getPropertyName(
    ts: typeof tslib,
    prop: tslib.ObjectLiteralElementLike
): string | undefined {
    const name = (prop as any).name;
    if (!name) return undefined;
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
    if (ts.isNumericLiteral(name)) return name.text;
    return undefined;
}

function findNodeAtPosition(
    ts: typeof tslib,
    sourceFile: tslib.SourceFile,
    position: number
): tslib.Node | undefined {
    function visit(node: tslib.Node): tslib.Node | undefined {
        if (position < node.getStart(sourceFile) || position > node.getEnd()) {
            return undefined;
        }
        const child = ts.forEachChild(node, visit);
        return child ?? node;
    }
    return visit(sourceFile);
}

export = init;
