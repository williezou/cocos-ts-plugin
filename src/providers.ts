import type * as tslib from "typescript/lib/tsserverlibrary";
import {
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
import { lookupClassName, resolveReceiverToClass } from "./resolver";
import type {
    DottedAccessHit,
    ExtendIndex,
    ExtendMemberContext,
    GetExpandoIndex,
    GetExtendIndex,
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
    ctx: ThisMemberContext
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
            const t = checker.getTypeAtLocation(valueNode);
            typeStr = checker.typeToString(t);
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

export function isAnyQuickInfo(ts: typeof tslib, qi: tslib.QuickInfo): boolean {
    if (!qi.displayParts) return false;
    const text = qi.displayParts.map((p) => p.text).join("");
    return /:\s*any\s*$/.test(text) || text === "any";
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
            ts, getExtendIndex, getProtoIndex, receiver, getExpandoIndex
        );
        if (className) {
            enumerateClass(ts, getExtendIndex, className, push);
            return out;
        }
        // otherwise fall through — receiver might be a plain dotted class name
    }

    // 3. `<dotted-class>.` — direct class members + expando children
    const dottedName = expressionToName(ts, receiver);
    if (dottedName) {
        const className = lookupClassName(getExtendIndex(), dottedName);
        if (className) enumerateClass(ts, getExtendIndex, className, push);

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
