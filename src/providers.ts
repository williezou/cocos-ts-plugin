import type * as tslib from "typescript/lib/tsserverlibrary";
import {
    classNameForFunction,
    expressionToName,
    findEnclosingExtendLiteral,
    findNodeAtPosition,
    findPrototypeOwnerClass,
    getLiteralOwner,
    getPropertyName,
    isWriteAccessOfPropertyAccess,
    walkExtendLiterals,
    walkThisAccesses,
} from "./ast";
import {
    collectProtoMembers,
    extractClassFromInitializer,
    lookupClassName,
    lookupProtoMember,
    resolveReceiverToClass,
} from "./resolver";
import type {
    DottedAccessHit,
    ExtendIndex,
    ExtendMemberContext,
    GetExpandoIndex,
    GetExtendIndex,
    GetIdentifierIndex,
    GetProtoIndex,
    PrototypeIndex,
    ThisMemberContext,
} from "./types";

// ─── Definition / hover builders ─────────────────────────────────────────────

export function buildDefinition(
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

export function buildQuickInfo(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    ctx: ThisMemberContext,
    getExtendIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    getExpandoIndex?: GetExpandoIndex,
    getIdentifierIndex?: GetIdentifierIndex
): tslib.QuickInfo | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const checker = program.getTypeChecker();

    const { sourceFile, identifier, memberName, property, valueNode } = ctx;

    const sourceStart = identifier.getStart(sourceFile);
    const sourceLength = identifier.getEnd() - sourceStart;

    let kind: tslib.ScriptElementKind = ts.ScriptElementKind.memberVariableElement;
    let label = "(property) ";
    let typeStr = "any";

    if (property && ts.isMethodDeclaration(property)) {
        const sig = checker.getSignatureFromDeclaration(property);
        typeStr = sig ? checker.signatureToString(sig) : "(...args: any[]) => any";
        kind = ts.ScriptElementKind.memberFunctionElement;
        label = "(method) ";
    } else if (valueNode) {
        if (ts.isFunctionExpression(valueNode) || ts.isArrowFunction(valueNode)) {
            const sig = checker.getSignatureFromDeclaration(valueNode);
            typeStr = sig ? checker.signatureToString(sig) : "(...args: any[]) => any";
            kind = ts.ScriptElementKind.memberFunctionElement;
            label = "(method) ";
        } else {
            // cocos 约定: `m_field: <ClassName>` 把字段类型注释为 <ClassName>。
            // 先按约定解析；解析不出来才落回 TS checker（无注解、字面量等）。
            let className = extractClassFromInitializer(ts, valueNode, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex);
            if (!className) {
                // 声明处写 `_field: null`、类型线索来自方法内 `this._field = <RHS>`
                // 时，checker 在后续使用点只会给出 `null`；用 proto 索引的赋值 RHS 补回。
                const ownerClass = findPrototypeOwnerClass(ts, identifier);
                if (ownerClass) {
                    for (const m of collectProtoMembers(getProtoIndex(), ownerClass, memberName)) {
                        className = extractClassFromInitializer(ts, m.initializer, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex);
                        if (className) break;
                    }
                }
            }
            if (className) {
                typeStr = className;
            } else {
                const t = checker.getTypeAtLocation(valueNode);
                typeStr = checker.typeToString(t);
            }
        }
    } else if (property && ts.isShorthandPropertyAssignment(property)) {
        const t = checker.getTypeAtLocation(property.name);
        typeStr = checker.typeToString(t);
    }

    return {
        kind,
        kindModifiers: "",
        textSpan: { start: sourceStart, length: sourceLength },
        displayParts: [
            { text: label, kind: "punctuation" },
            { text: memberName, kind: "propertyName" },
            { text: ": ", kind: "punctuation" },
            { text: typeStr, kind: "text" },
        ],
        documentation: property ? extractJSDocAsParts(ts, property) : [],
        tags: [],
    };
}

export function buildDefinitionFromExpando(
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

export function buildQuickInfoFromExpando(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    hit: DottedAccessHit,
    getExtendIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    getExpandoIndex?: GetExpandoIndex,
    getIdentifierIndex?: GetIdentifierIndex
): tslib.QuickInfo | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const checker = program.getTypeChecker();

    const { sourceFile, identifier, fullName, entry } = hit;
    const sourceStart = identifier.getStart(sourceFile);
    const sourceLength = identifier.getEnd() - sourceStart;

    let label = fullName.includes(".") ? "(property) " : "(var) ";
    let typeStr: string;
    let kind: tslib.ScriptElementKind = fullName.includes(".")
        ? ts.ScriptElementKind.memberVariableElement
        : ts.ScriptElementKind.variableElement;

    const init = entry.initializer;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        const sig = checker.getSignatureFromDeclaration(init);
        typeStr = sig ? checker.signatureToString(sig) : "(...args: any[]) => any";
        kind = ts.ScriptElementKind.memberFunctionElement;
        label = "(method) ";
    } else {
        // cocos 约定：`a.b.c = <Class>` 把成员类型注释为 <Class>。
        // 先按约定解析；解析不出来才落回 TS checker。
        const className = extractClassFromInitializer(ts, init, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex);
        if (className) {
            typeStr = className;
        } else {
            const t = checker.getTypeAtLocation(init);
            typeStr = checker.typeToString(t);
        }
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

export function isAnyQuickInfo(ts: typeof tslib, qi: tslib.QuickInfo): boolean {
    if (!qi.displayParts) return false;
    const text = qi.displayParts.map((p) => p.text).join("");
    return /:\s*any\s*$/.test(text) || text === "any";
}

/**
 * Hover on the `this` keyword inside a cocos `<Base>.extend({...})` literal.
 * tsserver types it `any` because `cc.Node.extend` has no declaration; by
 * cocos convention `this` is the instance the extend call constructs, so the
 * base name is the best available answer.
 */
export function buildQuickInfoForThis(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    fileName: string,
    position: number
): tslib.QuickInfo | undefined {
    const program = ls.getProgram();
    if (!program) return undefined;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return undefined;
    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node || node.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
    const literal = findEnclosingExtendLiteral(ts, node);
    if (!literal) return undefined;
    const owner = getLiteralOwner(ts, literal);
    const baseName = owner?.parentName;
    if (!baseName) return undefined;
    return {
        kind: ts.ScriptElementKind.variableElement,
        kindModifiers: "",
        textSpan: { start: node.getStart(sourceFile), length: node.getEnd() - node.getStart(sourceFile) },
        displayParts: [
            { text: "(local var) ", kind: "punctuation" },
            { text: "this", kind: "keyword" },
            { text: ": ", kind: "punctuation" },
            { text: baseName, kind: "text" },
        ],
        documentation: [],
        tags: [],
    };
}

/**
 * tsserver answers that carry no structural information: `any`, or the bare
 * initial value (`null`/`undefined`) of a field whose real type only shows up
 * in assignments the checker can't see from the hovered position. The plugin
 * gets a chance to improve on these before they are returned as-is.
 */
export function isWeakQuickInfo(ts: typeof tslib, qi: tslib.QuickInfo): boolean {
    if (isAnyQuickInfo(ts, qi)) return true;
    if (!qi.displayParts) return false;
    const text = qi.displayParts.map((p) => p.text).join("");
    return /:\s*(?:null|undefined)\s*$/.test(text);
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

// ─── Member completion (post-`.`) ────────────────────────────────────────────

export function collectMemberCompletions(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getExtendIndex: GetExtendIndex,
    getExpandoIndex: GetExpandoIndex,
    getProtoIndex: GetProtoIndex,
    getIdentifierIndex: GetIdentifierIndex,
    fileName: string,
    position: number
): tslib.CompletionEntry[] {
    const program = ls.getProgram();
    if (!program) return [];
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return [];

    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node) return [];

    // The cursor sits inside a PropertyAccessExpression's `.name` slot — either
    // an empty/incomplete identifier right after a `.`, or an in-progress one.
    const parent = node.parent;
    let access: tslib.PropertyAccessExpression | undefined;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        access = parent;
    } else if (ts.isPropertyAccessExpression(node)) {
        access = node;
    }
    if (!access) return [];

    const receiver = access.expression;
    const out: tslib.CompletionEntry[] = [];
    const seen = new Set<string>();
    const push = (name: string, kind: tslib.ScriptElementKind): void => {
        if (seen.has(name)) return;
        seen.add(name);
        out.push({ name, kind, kindModifiers: "", sortText: "0" });
    };

    // 1. `this.` -> enclosing extend literal + chain, or prototype chain
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
        const literal = findEnclosingExtendLiteral(ts, access);
        if (literal) {
            enumerateLiteralAndChain(ts, getExtendIndex, literal, push);
            return out;
        }
        const protoClass = findPrototypeOwnerClass(ts, access);
        if (protoClass) enumerateProtoChain(ts, getProtoIndex, protoClass, push);
        return out;
    }

    // 2. `<expr>.<field>.` (`this.m_layout.`, `this._spineAni.nodeDelay.`, …)
    if (ts.isPropertyAccessExpression(receiver)) {
        const className = resolveReceiverToClass(
            ts, getExtendIndex, getProtoIndex, receiver, getExpandoIndex, getIdentifierIndex
        );
        if (className) {
            enumerateClass(ts, getExtendIndex, getProtoIndex, className, push);
            return out;
        }
        // otherwise fall through — receiver might be a plain dotted class name
    }

    // 2b. Bare identifier (`shBeachMgr.`) — resolve through identifier index.
    if (ts.isIdentifier(receiver)) {
        const className = resolveReceiverToClass(
            ts, getExtendIndex, getProtoIndex, receiver, getExpandoIndex, getIdentifierIndex
        );
        if (className) {
            enumerateClass(ts, getExtendIndex, getProtoIndex, className, push);
            return out;
        }
    }

    // 2c. Call result (`this.activityInfo().`) — receiver is a CallExpression.
    if (ts.isCallExpression(receiver)) {
        const className = resolveReceiverToClass(
            ts, getExtendIndex, getProtoIndex, receiver, getExpandoIndex, getIdentifierIndex
        );
        if (className) {
            enumerateClass(ts, getExtendIndex, getProtoIndex, className, push);
            return out;
        }
    }

    // 3. `<dotted-class>.` — direct class members + expando children
    const dottedName = expressionToName(ts, receiver);
    if (dottedName) {
        const className = lookupClassName(getExtendIndex(), dottedName, getProtoIndex());
        if (className) enumerateClass(ts, getExtendIndex, getProtoIndex, className, push);

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
    getIndex: GetExtendIndex,
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
    getIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    className: string,
    push: (name: string, kind: tslib.ScriptElementKind) => void
): void {
    const entries = getIndex().get(className);
    if (entries && entries.length > 0) {
        for (const entry of entries) {
            for (const prop of entry.literal.properties) {
                const n = getPropertyName(ts, prop);
                if (n) push(n, classifyPropertyKind(ts, prop));
            }
        }
        if (entries[0].parentName) {
            walkChainEnumerate(ts, getIndex, entries[0].parentName, push);
        }
        return;
    }
    // Prototype/constructor-style class (no extend literal).
    enumerateProtoChain(ts, getProtoIndex, className, push);
}

function walkChainEnumerate(
    ts: typeof tslib,
    getIndex: GetExtendIndex,
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

function enumerateProtoChain(
    ts: typeof tslib,
    getIndex: GetProtoIndex,
    startClass: string,
    push: (name: string, kind: tslib.ScriptElementKind) => void
): void {
    const index = getIndex();
    const seen = new Set<string>();
    const queue: string[] = [startClass];
    while (queue.length > 0) {
        const cls = queue.shift()!;
        if (seen.has(cls)) continue;
        seen.add(cls);
        const entry = index.get(cls);
        if (!entry) continue;
        for (const m of entry.members) {
            const isFn = ts.isFunctionExpression(m.initializer) || ts.isArrowFunction(m.initializer);
            push(
                m.memberName,
                isFn ? ts.ScriptElementKind.memberFunctionElement : ts.ScriptElementKind.memberVariableElement
            );
        }
        for (const p of entry.parents) queue.push(p);
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

// ─── Find References ────────────────────────────────────────────────────────

export function scanExtendReferences(
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

/**
 * Finds declarations and uses of one exact expando/object-literal member.
 * Matching the complete dotted name keeps unrelated methods with the same
 * trailing name out of the result.
 */
export function scanExpandoReferences(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getExpandoIndex: GetExpandoIndex,
    fullName: string
): tslib.ReferenceEntry[] {
    const program = ls.getProgram();
    if (!program) return [];

    const refs: tslib.ReferenceEntry[] = [];
    const definitions = getExpandoIndex().get(fullName) ?? [];
    for (const entry of definitions) {
        const start = entry.nameNode.getStart(entry.sourceFile);
        refs.push({
            fileName: entry.sourceFile.fileName,
            textSpan: { start, length: entry.nameNode.getEnd() - start },
            isWriteAccess: true,
        });
    }

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        function visit(node: tslib.Node): void {
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.name) &&
                expressionToName(ts, node) === fullName
            ) {
                const start = node.name.getStart(sf);
                refs.push({
                    fileName: sf.fileName,
                    textSpan: { start, length: node.name.getEnd() - start },
                    isWriteAccess: isWriteAccessOfPropertyAccess(ts, node.name),
                });
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
    }
    return dedupeReferences(refs);
}

/** Finds one prototype member's declaration and calls through its class chain. */
export function scanPrototypeReferences(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getExtendIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    getExpandoIndex: GetExpandoIndex,
    getIdentifierIndex: GetIdentifierIndex,
    className: string,
    memberName: string
): tslib.ReferenceEntry[] {
    const program = ls.getProgram();
    if (!program) return [];
    const index = getProtoIndex();
    const refs: tslib.ReferenceEntry[] = [];

    const entry = index.get(className);
    if (entry) {
        for (const member of entry.members) {
            if (member.memberName !== memberName) continue;
            const start = member.nameNode.getStart(member.sourceFile);
            refs.push({
                fileName: member.sourceFile.fileName,
                textSpan: { start, length: member.nameNode.getEnd() - start },
                isWriteAccess: true,
            });
        }
    }

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        function visit(node: tslib.Node): void {
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.name) &&
                prototypeAccessMatches(
                    ts,
                    node,
                    getExtendIndex,
                    getProtoIndex,
                    getExpandoIndex,
                    getIdentifierIndex,
                    className,
                    memberName
                )
            ) {
                const start = node.name.getStart(sf);
                refs.push({
                    fileName: sf.fileName,
                    textSpan: { start, length: node.name.getEnd() - start },
                    isWriteAccess: isWriteAccessOfPropertyAccess(ts, node.name),
                });
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
    }
    return dedupeReferences(refs);
}

/**
 * Matches a prototype member access in legacy JS. Exact `this`/`self` and
 * statically resolvable receivers stay class-safe. If a receiver remains
 * `any` (for example `handler.handler` read from a Map), treat it as a
 * duck-typed dispatch site. Explicit indexed objects such as
 * `Midautumn26Config.checkShowRed` are known different symbols and excluded.
 */
function prototypeAccessMatches(
    ts: typeof tslib,
    access: tslib.PropertyAccessExpression,
    getExtendIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    getExpandoIndex: GetExpandoIndex,
    getIdentifierIndex: GetIdentifierIndex,
    className: string,
    memberName: string
): boolean {
    if (!ts.isIdentifier(access.name) || access.name.text !== memberName) return false;

    const index = getProtoIndex();
    const thisOwner = prototypeThisOwner(ts, access);
    if (thisOwner) {
        return lookupProtoMember(index, thisOwner, memberName)?.className === className;
    }

    const receiverClass = resolveReceiverToClass(
        ts,
        getExtendIndex,
        getProtoIndex,
        access.expression,
        getExpandoIndex,
        getIdentifierIndex
    );
    if (receiverClass) {
        return lookupProtoMember(index, receiverClass, memberName)?.className === className;
    }

    const fullName = expressionToName(ts, access);
    if (fullName && getExpandoIndex().has(fullName)) return false;

    // No indexed symbol or receiver type owns this access. In legacy cocos JS
    // this is commonly an interface-style dispatch through Map/array data.
    return true;
}

function prototypeThisOwner(
    ts: typeof tslib,
    access: tslib.PropertyAccessExpression
): string | undefined {
    const receiver = access.expression;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
        return findPrototypeOwnerClass(ts, access);
    }
    if (!ts.isIdentifier(receiver)) return undefined;

    const owner = findPrototypeOwnerFunction(ts, access);
    if (!owner || !hasThisAlias(ts, owner.fn, receiver.text, access.getStart())) {
        return undefined;
    }
    return owner.className;
}

function findPrototypeOwnerFunction(
    ts: typeof tslib,
    start: tslib.Node
): { className: string; fn: tslib.Node } | undefined {
    let current: tslib.Node | undefined = start.parent;
    while (current) {
        if (
            ts.isFunctionDeclaration(current) ||
            ts.isFunctionExpression(current) ||
            ts.isArrowFunction(current)
        ) {
            const className = classNameForFunction(ts, current);
            if (className) return { className, fn: current };
        }
        current = current.parent;
    }
    return undefined;
}

function hasThisAlias(
    ts: typeof tslib,
    ownerFunction: tslib.Node,
    alias: string,
    beforePosition: number
): boolean {
    let found = false;
    function visit(node: tslib.Node): void {
        if (found || node.getStart() >= beforePosition) return;
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === alias &&
            node.initializer?.kind === ts.SyntaxKind.ThisKeyword
        ) {
            found = true;
            return;
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            node.left.text === alias &&
            node.right.kind === ts.SyntaxKind.ThisKeyword
        ) {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    }
    ts.forEachChild(ownerFunction, visit);
    return found;
}

export function mergeReferences(
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

export function mergeExpandoReferences(
    ts: typeof tslib,
    original: tslib.ReferencedSymbol[] | undefined,
    extra: tslib.ReferenceEntry[],
    ctx: DottedAccessHit
): tslib.ReferencedSymbol[] | undefined {
    const combined: tslib.ReferenceEntry[] = [];
    if (original) {
        for (const symbol of original) combined.push(...symbol.references);
    }
    combined.push(...extra);
    const refs = dedupeReferences(combined);
    if (refs.length === 0) return original;

    const nameNode = ctx.entry.nameNode;
    const sf = ctx.entry.sourceFile;
    const start = nameNode.getStart(sf);
    const definition: tslib.ReferencedSymbolDefinitionInfo = original?.[0]?.definition ?? {
        containerKind: ts.ScriptElementKind.classElement,
        containerName: ctx.fullName.substring(0, ctx.fullName.lastIndexOf(".")),
        fileName: sf.fileName,
        kind: ts.ScriptElementKind.memberVariableElement,
        name: ctx.fullName,
        textSpan: { start, length: nameNode.getEnd() - start },
        displayParts: [{ text: ctx.fullName, kind: "propertyName" }],
    };
    return [{ definition, references: refs }];
}

// ─── Implementations ────────────────────────────────────────────────────────

export function collectPrototypeImplementations(
    ts: typeof tslib,
    getProtoIndex: GetProtoIndex,
    className: string,
    memberName: string
): tslib.ImplementationLocation[] {
    const index = getProtoIndex();
    const out: tslib.ImplementationLocation[] = [];

    for (const [candidateClass, entry] of index) {
        if (!prototypeClassIsOrExtends(index, candidateClass, className)) continue;
        for (const member of entry.members) {
            if (member.memberName !== memberName) continue;
            out.push(buildImplementationLocation(
                ts,
                member.sourceFile,
                member.nameNode,
                member.initializer,
                `${member.className}.${member.memberName}`
            ));
        }
    }
    return dedupeImplementations(out);
}

export function collectExpandoImplementations(
    ts: typeof tslib,
    getExpandoIndex: GetExpandoIndex,
    fullName: string
): tslib.ImplementationLocation[] {
    const entries = getExpandoIndex().get(fullName) ?? [];
    return dedupeImplementations(entries.map((entry) =>
        buildImplementationLocation(
            ts,
            entry.sourceFile,
            entry.nameNode,
            entry.initializer,
            fullName
        )
    ));
}

export function mergeImplementations(
    original: readonly tslib.ImplementationLocation[] | undefined,
    extra: tslib.ImplementationLocation[]
): readonly tslib.ImplementationLocation[] | undefined {
    const merged = dedupeImplementations([...(original ?? []), ...extra]);
    return merged.length > 0 ? merged : original;
}

function buildImplementationLocation(
    ts: typeof tslib,
    sourceFile: tslib.SourceFile,
    nameNode: tslib.Node,
    initializer: tslib.Node,
    displayName: string
): tslib.ImplementationLocation {
    const nameStart = nameNode.getStart(sourceFile);
    const contextStart = Math.min(nameStart, initializer.getStart(sourceFile));
    const contextEnd = Math.max(nameNode.getEnd(), initializer.getEnd());
    const isFunction =
        ts.isFunctionExpression(initializer) ||
        ts.isArrowFunction(initializer) ||
        ts.isMethodDeclaration(initializer);
    return {
        fileName: sourceFile.fileName,
        textSpan: { start: nameStart, length: nameNode.getEnd() - nameStart },
        contextSpan: { start: contextStart, length: contextEnd - contextStart },
        kind: isFunction
            ? ts.ScriptElementKind.memberFunctionElement
            : ts.ScriptElementKind.memberVariableElement,
        displayParts: [{ text: displayName, kind: isFunction ? "methodName" : "propertyName" }],
    };
}

function prototypeClassIsOrExtends(
    index: PrototypeIndex,
    candidateClass: string,
    targetClass: string
): boolean {
    const seen = new Set<string>();
    const queue = [candidateClass];
    while (queue.length > 0) {
        const className = queue.shift()!;
        if (className === targetClass) return true;
        if (seen.has(className)) continue;
        seen.add(className);
        const entry = index.get(className);
        if (entry) queue.push(...entry.parents);
    }
    return false;
}

function dedupeImplementations(
    implementations: readonly tslib.ImplementationLocation[]
): tslib.ImplementationLocation[] {
    const seen = new Set<string>();
    const out: tslib.ImplementationLocation[] = [];
    for (const implementation of implementations) {
        const key = `${implementation.fileName}:${implementation.textSpan.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(implementation);
    }
    return out;
}

// ─── Call hierarchy ─────────────────────────────────────────────────────────

export function buildCallHierarchyItem(
    ts: typeof tslib,
    ctx: DottedAccessHit
): tslib.CallHierarchyItem {
    const sf = ctx.entry.sourceFile;
    const nameNode = ctx.entry.nameNode;
    const init = ctx.entry.initializer;
    const dot = ctx.fullName.lastIndexOf(".");
    const selectionStart = nameNode.getStart(sf);
    // VS Code requires selectionSpan to be contained by span. For expando and
    // prototype assignments the member name is before the RHS function, so a
    // span starting at `function` is invalid and the UI silently shows no item.
    const spanStart = Math.min(selectionStart, init.getStart(sf));
    const spanEnd = Math.max(nameNode.getEnd(), init.getEnd());
    return {
        name: dot >= 0 ? ctx.fullName.substring(dot + 1) : ctx.fullName,
        kind:
            ts.isFunctionExpression(init) || ts.isArrowFunction(init) || ts.isMethodDeclaration(init)
                ? ts.ScriptElementKind.memberFunctionElement
                : ts.ScriptElementKind.memberVariableElement,
        kindModifiers: "",
        file: sf.fileName,
        span: { start: spanStart, length: spanEnd - spanStart },
        selectionSpan: {
            start: selectionStart,
            length: nameNode.getEnd() - selectionStart,
        },
        containerName: dot >= 0 ? ctx.fullName.substring(0, dot) : undefined,
    };
}

export function collectExpandoIncomingCalls(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    fullName: string
): tslib.CallHierarchyIncomingCall[] {
    return collectIncomingCalls(ts, ls, (access) => expressionToName(ts, access) === fullName);
}

export function collectPrototypeIncomingCalls(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getExtendIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    getExpandoIndex: GetExpandoIndex,
    getIdentifierIndex: GetIdentifierIndex,
    className: string,
    memberName: string
): tslib.CallHierarchyIncomingCall[] {
    return collectIncomingCalls(ts, ls, (access) => prototypeAccessMatches(
        ts,
        access,
        getExtendIndex,
        getProtoIndex,
        getExpandoIndex,
        getIdentifierIndex,
        className,
        memberName
    ));
}

function collectIncomingCalls(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    matches: (access: tslib.PropertyAccessExpression) => boolean
): tslib.CallHierarchyIncomingCall[] {
    const program = ls.getProgram();
    if (!program) return [];
    const grouped = new Map<string, tslib.CallHierarchyIncomingCall>();

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        function visit(node: tslib.Node): void {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                matches(node.expression)
            ) {
                const access = node.expression;
                const caller = callHierarchyCaller(ts, access, sf);
                const key = `${caller.file}:${caller.selectionSpan.start}`;
                let incoming = grouped.get(key);
                if (!incoming) {
                    incoming = { from: caller, fromSpans: [] };
                    grouped.set(key, incoming);
                }
                const start = access.name.getStart(sf);
                incoming.fromSpans.push({
                    start,
                    length: access.name.getEnd() - start,
                });
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
    }
    return [...grouped.values()];
}

function callHierarchyCaller(
    ts: typeof tslib,
    callSite: tslib.Node,
    sf: tslib.SourceFile
): tslib.CallHierarchyItem {
    let cur: tslib.Node | undefined = callSite.parent;
    while (cur && cur !== sf) {
        if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
        ) {
            const item = namedFunctionCallHierarchyItem(ts, cur, sf);
            if (item) return item;
        }
        cur = cur.parent;
    }

    const fileName = sf.fileName.split(/[\\/]/).pop() ?? sf.fileName;
    return {
        name: fileName,
        kind: ts.ScriptElementKind.scriptElement,
        kindModifiers: "",
        file: sf.fileName,
        span: { start: 0, length: sf.getEnd() },
        selectionSpan: { start: 0, length: 0 },
    };
}

function namedFunctionCallHierarchyItem(
    ts: typeof tslib,
    fn: tslib.FunctionDeclaration | tslib.FunctionExpression | tslib.ArrowFunction | tslib.MethodDeclaration,
    sf: tslib.SourceFile
): tslib.CallHierarchyItem | undefined {
    let nameNode: tslib.Node | undefined;
    let name: string | undefined;
    let containerName: string | undefined;

    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
        nameNode = fn.name;
        name = nodeName(ts, fn.name);
    } else {
        const parent = fn.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            nameNode = parent.name;
            name = parent.name.text;
        } else if (ts.isPropertyAssignment(parent)) {
            nameNode = parent.name;
            name = nodeName(ts, parent.name);
        } else if (
            ts.isBinaryExpression(parent) &&
            parent.right === fn &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const fullName = expressionToName(ts, parent.left);
            if (fullName) {
                const dot = fullName.lastIndexOf(".");
                name = dot >= 0 ? fullName.substring(dot + 1) : fullName;
                containerName = dot >= 0
                    ? fullName.substring(0, dot).replace(/\.prototype$/, "")
                    : undefined;
                nameNode = ts.isPropertyAccessExpression(parent.left)
                    ? parent.left.name
                    : parent.left;
            }
        }
    }
    if (!nameNode || !name) return undefined;

    const selectionStart = nameNode.getStart(sf);
    const spanStart = Math.min(selectionStart, fn.getStart(sf));
    const spanEnd = Math.max(nameNode.getEnd(), fn.getEnd());
    return {
        name,
        kind: ts.ScriptElementKind.functionElement,
        kindModifiers: "",
        file: sf.fileName,
        span: { start: spanStart, length: spanEnd - spanStart },
        selectionSpan: {
            start: selectionStart,
            length: nameNode.getEnd() - selectionStart,
        },
        containerName,
    };
}

function nodeName(ts: typeof tslib, node: tslib.Node): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
        return node.text;
    }
    return undefined;
}

export function dedupeReferences(refs: tslib.ReferenceEntry[]): tslib.ReferenceEntry[] {
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
