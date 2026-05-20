import type * as tslib from "typescript/lib/tsserverlibrary";

function init(modules: { typescript: typeof tslib }) {
    const ts = modules.typescript;

    function create(info: tslib.server.PluginCreateInfo): tslib.LanguageService {
        const ls = info.languageService;
        const log = (msg: string) =>
            info.project.projectService.logger.info(`[cocos-ts-plugin] ${msg}`);

        log("plugin loaded v0.1.2");

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
                const ctx = locateThisMember(ts, ls, fileName, position);
                if (!ctx) {
                    log(`def: no extend-this context at ${fileName}:${position}`);
                    return original;
                }
                log(`def: resolved this.${ctx.memberName} -> offset ${ctx.propertyNameNode.getStart(ctx.sourceFile)}`);
                return buildDefinition(ts, ctx);
            }, ls.getDefinitionAndBoundSpan(fileName, position));

        proxy.getDefinitionAtPosition = (fileName, position) =>
            guard("getDefinitionAtPosition", () => {
                const original = ls.getDefinitionAtPosition(fileName, position);
                if (original && original.length > 0) return original;
                const ctx = locateThisMember(ts, ls, fileName, position);
                if (!ctx) return undefined;
                const built = buildDefinition(ts, ctx);
                return built?.definitions as tslib.DefinitionInfo[] | undefined;
            }, ls.getDefinitionAtPosition(fileName, position));

        proxy.getQuickInfoAtPosition = (fileName, position) =>
            guard("getQuickInfoAtPosition", () => {
                const original = ls.getQuickInfoAtPosition(fileName, position);
                if (original && !isAnyQuickInfo(ts, original)) return original;
                const ctx = locateThisMember(ts, ls, fileName, position);
                if (!ctx) return original;
                log(`hover: resolving this.${ctx.memberName}`);
                return buildQuickInfo(ts, ls, ctx) ?? original;
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
}

interface ExtendMemberContext {
    sourceFile: tslib.SourceFile;
    memberName: string;
    /** The identifier node at the cursor (either `xxx` in `this.xxx` or `xxx:` in literal). */
    identifier: tslib.Identifier;
}

function locateThisMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
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

    const memberName = node.text;

    const literal = findEnclosingExtendLiteral(ts, parent);
    if (!literal) return undefined;

    const property = findPropertyByName(ts, literal, memberName);
    if (!property) return undefined;
    const propertyNameNode = (property as any).name ?? property;

    return {
        sourceFile,
        identifier: node,
        memberName,
        property,
        propertyNameNode,
    };
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

    // Case 1: this.xxx
    if (
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        parent.expression.kind === ts.SyntaxKind.ThisKeyword &&
        findEnclosingExtendLiteral(ts, parent)
    ) {
        return { sourceFile, memberName: node.text, identifier: node };
    }

    // Case 2: property name in extend literal
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

function buildDefinition(
    ts: typeof tslib,
    ctx: ThisMemberContext
): tslib.DefinitionInfoAndBoundSpan {
    const { sourceFile, identifier, memberName, propertyNameNode } = ctx;
    const sourceStart = identifier.getStart(sourceFile);
    const sourceLength = identifier.getEnd() - sourceStart;
    const destStart = propertyNameNode.getStart(sourceFile);
    const destLength = propertyNameNode.getEnd() - destStart;

    return {
        textSpan: { start: sourceStart, length: sourceLength },
        definitions: [
            {
                fileName: sourceFile.fileName,
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
            // 1. Property declarations matching the name.
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
            // 2. this.xxx accesses inside the literal.
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
    // id is the .name of a PropertyAccessExpression; check if it's the LHS of an assignment.
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
    // Allow position == node.getEnd() so the cursor "just past" an identifier
    // (e.g., right before a `:` or `(`) still resolves to that identifier.
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
