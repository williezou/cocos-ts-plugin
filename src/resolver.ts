import type * as tslib from "typescript/lib/tsserverlibrary";
import {
    expressionToName,
    extractValueNode,
    findEnclosingExtendLiteral,
    findNodeAtPosition,
    findPrototypeOwnerClass,
    findPropertyByName,
    getLiteralOwner,
    isExtendCall,
} from "./ast";
import type {
    DottedAccessHit,
    ExpandoIndex,
    ExtendIndex,
    ExtendMemberContext,
    GetExpandoIndex,
    GetExtendIndex,
    GetProtoIndex,
    LiteralHit,
    PrototypeIndex,
    PrototypeMember,
    ThisMemberContext,
} from "./types";

// ─── Locators ────────────────────────────────────────────────────────────────
// Each `locate*` answers: given a cursor position, can I identify a member that
// my plugin should resolve? They each consume a different cocos pattern.

/**
 * Cursor is on the `xxx` identifier of `this.xxx` inside a cocos
 * `<Base>.extend({...})` literal. Walks the extend parent chain (with expando
 * augmentation per step) to find the property.
 */
export function locateThisMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getIndex: GetExtendIndex,
    getExpandoIndex: GetExpandoIndex,
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
    const hit = lookupInLiteralAndChain(ts, getIndex, literal, memberName, getExpandoIndex);
    if (!hit) return undefined;
    return makeContext(sourceFile, node, memberName, hit);
}

/**
 * Cursor is on `this.xxx` inside a classical-prototype / constructor-style class:
 *   <Class>.prototype.someMethod = function () { this.xxx /* here *\/ }
 *   <Class>.prototype = { someMethod: function () { this.xxx /* here *\/ } }
 *   let <Class> = function () { this.foo = function () { this.xxx /* here *\/ } }
 * Walks the prototype-parent chain to find `xxx`'s definition site.
 */
export function locateThisProtoMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getProtoIndex: GetProtoIndex,
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
    if (parent.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;

    const className = findPrototypeOwnerClass(ts, parent);
    if (!className) return undefined;

    const member = lookupProtoMember(getProtoIndex(), className, node.text);
    if (!member) return undefined;

    // Reuse the DottedAccessHit shape so the existing builders can render
    // definition + hover. `fullName` is `<Class>.<member>` for display.
    return {
        sourceFile,
        identifier: node,
        fullName: `${className}.${node.text}`,
        entry: {
            fullName: `${className}.${node.text}`,
            nameNode: member.nameNode,
            initializer: member.initializer,
            sourceFile: member.sourceFile,
        },
    };
}

/**
 * Cursor is on the trailing `.sub` of `<receiver>.sub` where `<receiver>` is not
 * `this` — e.g., `this.m_layout.setBackGroundColor()` or
 * `sp.SkeletonAnimation.createWithJsonFile(...)`. Resolves `<receiver>` to a
 * class via type hints / factory inference, then walks that class's chain.
 */
export function locateChainedMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    getExpandoIndex: GetExpandoIndex,
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

    const className = resolveReceiverToClass(
        ts, getIndex, getProtoIndex, receiver, getExpandoIndex
    );
    if (!className) return undefined;

    const memberName = node.text;
    const entries = getIndex().get(className);
    if (entries && entries.length > 0) {
        for (const entry of entries) {
            const hit = lookupInLiteralAndChain(
                ts, getIndex, entry.literal, memberName, getExpandoIndex
            );
            if (hit) return makeContext(sourceFile, node, memberName, hit);
        }
    }
    // Fallback: maybe the member lives directly as an expando on `className` itself.
    const onClass = expandoHit(getExpandoIndex(), className, memberName);
    if (onClass) return makeContext(sourceFile, node, memberName, onClass);
    return undefined;
}

/**
 * Cursor is on the trailing identifier of a direct dotted access whose full
 * chain matches an expando entry — e.g., `sp.SkeletonAnimation.createWithJsonFile`
 * or `ccui.Widget.TOUCH_ENDED`.
 */
export function locateDottedAccess(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getIndex: GetExpandoIndex,
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
    if (parent.expression.kind === ts.SyntaxKind.ThisKeyword) return undefined;

    const fullName = expressionToName(ts, parent);
    if (!fullName || !fullName.includes(".")) return undefined;

    const entries = getIndex().get(fullName);
    if (!entries || entries.length === 0) return undefined;

    return { sourceFile, identifier: node, fullName, entry: entries[0] };
}

/**
 * Cursor is on a member name in an extend literal — either the `xxx` of
 * `this.xxx` access, or the `xxx:` property declaration itself. Used by
 * find-references to know we're inside an extend-style class.
 */
export function resolveExtendMember(
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

// ─── Class / receiver resolution ─────────────────────────────────────────────

/**
 * Given an expression on the LHS of a `.<member>` access, returns the class
 * name that `<member>` should be looked up on. Handles:
 *   - `this.<field>` — find the field's type hint via extend/proto indices
 *   - `<a>.<b>.<c>` — recursively resolve `<a>.<b>` then look up `<c>`
 *   - `<dotted name>` — direct class name match (cc.Node, sp.SkeletonAnimation, …)
 */
export function resolveReceiverToClass(
    ts: typeof tslib,
    getExtendIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    receiver: tslib.Expression,
    getExpandoIndex?: GetExpandoIndex
): string | undefined {
    // Case A: `this.<member>`
    if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        const memberName = receiver.name.text;

        // A1: extend-literal field (`m_layout: ccui.layout` style)
        const literal = findEnclosingExtendLiteral(ts, receiver);
        if (literal) {
            const hit = lookupInLiteralAndChain(
                ts, getExtendIndex, literal, memberName, getExpandoIndex
            );
            if (hit?.valueNode) {
                const cls = extractClassFromInitializer(ts, hit.valueNode, getExtendIndex);
                if (cls) return cls;
            }
        }

        // A2: prototype / constructor-body assignments (`this._spineAni = ...`)
        const ownerClass = findPrototypeOwnerClass(ts, receiver);
        if (ownerClass) {
            const members = collectProtoMembers(getProtoIndex(), ownerClass, memberName);
            for (const m of members) {
                const cls = extractClassFromInitializer(ts, m.initializer, getExtendIndex);
                if (cls) return cls;
            }
        }
        return undefined;
    }

    // Case B: dotted name that matches a known class directly
    const direct = expressionToName(ts, receiver);
    if (direct) {
        const found = lookupClassName(getExtendIndex(), direct);
        if (found) return found;
    }

    // Case C: multi-level chain — `<sub>.<field>` where <sub> isn't `this`.
    // Recursively resolve <sub> to a class, then look up <field>'s type hint
    // in that class's chain (including augmented expando entries from pass 2).
    if (ts.isPropertyAccessExpression(receiver)) {
        const subClass = resolveReceiverToClass(
            ts, getExtendIndex, getProtoIndex, receiver.expression, getExpandoIndex
        );
        if (!subClass) return undefined;
        const fieldName = receiver.name.text;

        const entries = getExtendIndex().get(subClass);
        if (entries) {
            for (const entry of entries) {
                const hit = lookupInLiteralAndChain(
                    ts, getExtendIndex, entry.literal, fieldName, getExpandoIndex
                );
                if (hit?.valueNode) {
                    const cls = extractClassFromInitializer(ts, hit.valueNode, getExtendIndex);
                    if (cls) return cls;
                }
            }
        }
        if (getExpandoIndex) {
            const eHit = expandoHit(getExpandoIndex(), subClass, fieldName);
            if (eHit?.valueNode) {
                const cls = extractClassFromInitializer(ts, eHit.valueNode, getExtendIndex);
                if (cls) return cls;
            }
        }
    }
    return undefined;
}

/**
 * Heuristic: turn an assignment RHS into a class name in the extend index.
 *   - `<X>` identifier or dotted name -> X (type-hint convention)
 *   - `new <X>(...)` -> X
 *   - `<X>.create(...)` / `<X>.createWithXxx(...)` etc. -> X (cocos factory convention)
 *   - null / unrecognized -> undefined (caller skips and tries next initializer)
 */
export function extractClassFromInitializer(
    ts: typeof tslib,
    init: tslib.Expression | undefined,
    getExtendIndex: GetExtendIndex
): string | undefined {
    if (!init) return undefined;
    if (init.kind === ts.SyntaxKind.NullKeyword) return undefined;
    if (init.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;

    const direct = expressionToName(ts, init);
    if (direct) {
        const found = lookupClassName(getExtendIndex(), direct);
        if (found) return found;
    }
    if (ts.isNewExpression(init)) {
        const ctorName = expressionToName(ts, init.expression);
        if (ctorName) {
            const found = lookupClassName(getExtendIndex(), ctorName);
            if (found) return found;
        }
    }
    if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)) {
        const receiverName = expressionToName(ts, init.expression.expression);
        if (receiverName) {
            const found = lookupClassName(getExtendIndex(), receiverName);
            if (found) return found;
        }
    }
    return undefined;
}

// ─── Index lookups ───────────────────────────────────────────────────────────

/**
 * Class-name lookup with a capitalization fallback: tries the exact name first,
 * then the last segment with its first letter capitalized. Handles project
 * conventions like `m_layout: ccui.layout` where the namespace is lowercased
 * but the real class is `ccui.Layout`.
 */
export function lookupClassName(index: ExtendIndex, name: string): string | undefined {
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

/**
 * Searches `literal` for `memberName`. If not found, walks the extend parent
 * chain and at each step also checks the expando index under
 * `<className>.<memberName>` (so auto-api stubs augment the chain seamlessly).
 */
export function lookupInLiteralAndChain(
    ts: typeof tslib,
    getIndex: GetExtendIndex,
    literal: tslib.ObjectLiteralExpression,
    memberName: string,
    getExpandoIndex?: GetExpandoIndex
): LiteralHit | undefined {
    const direct = findPropertyByName(ts, literal, memberName);
    if (direct) return hitFromProperty(direct, literal.getSourceFile());

    const owner = getLiteralOwner(ts, literal);
    if (!owner) return undefined;
    if (getExpandoIndex) {
        const ownHit = expandoHit(getExpandoIndex(), owner.className, memberName);
        if (ownHit) return ownHit;
    }
    if (!owner.parentName) return undefined;
    return walkChain(ts, getIndex, owner.parentName, memberName, getExpandoIndex);
}

export function walkChain(
    ts: typeof tslib,
    getIndex: GetExtendIndex,
    startParent: string,
    memberName: string,
    getExpandoIndex?: GetExpandoIndex
): LiteralHit | undefined {
    const index = getIndex();
    const seen = new Set<string>();
    let parentName: string | undefined = startParent;
    while (parentName && !seen.has(parentName)) {
        seen.add(parentName);
        const entries = index.get(parentName);
        if (entries && entries.length > 0) {
            for (const entry of entries) {
                const prop = findPropertyByName(ts, entry.literal, memberName);
                if (prop) return hitFromProperty(prop, entry.sourceFile);
            }
        }
        if (getExpandoIndex) {
            const eHit = expandoHit(getExpandoIndex(), parentName, memberName);
            if (eHit) return eHit;
        }
        parentName = entries?.[0]?.parentName;
    }
    return undefined;
}

export function lookupProtoMember(
    index: PrototypeIndex,
    startClass: string,
    memberName: string
): PrototypeMember | undefined {
    const seen = new Set<string>();
    const queue: string[] = [startClass];
    while (queue.length > 0) {
        const cls = queue.shift()!;
        if (seen.has(cls)) continue;
        seen.add(cls);
        const entry = index.get(cls);
        if (!entry) continue;
        for (const m of entry.members) {
            if (m.memberName === memberName) return m;
        }
        for (const p of entry.parents) queue.push(p);
    }
    return undefined;
}

export function collectProtoMembers(
    index: PrototypeIndex,
    startClass: string,
    memberName: string
): PrototypeMember[] {
    const out: PrototypeMember[] = [];
    const seen = new Set<string>();
    const queue: string[] = [startClass];
    while (queue.length > 0) {
        const cls = queue.shift()!;
        if (seen.has(cls)) continue;
        seen.add(cls);
        const entry = index.get(cls);
        if (!entry) continue;
        for (const m of entry.members) {
            if (m.memberName === memberName) out.push(m);
        }
        for (const p of entry.parents) queue.push(p);
    }
    return out;
}

// ─── LiteralHit construction ────────────────────────────────────────────────

export function hitFromProperty(
    prop: tslib.ObjectLiteralElementLike,
    sf: tslib.SourceFile
): LiteralHit {
    const nameNode: tslib.Node = (prop as any).name ?? prop;
    const valueNode: tslib.Expression | undefined = (prop as any).initializer ?? undefined;
    return { property: prop, nameNode, valueNode, propertySourceFile: sf };
}

export function expandoHit(
    expando: ExpandoIndex,
    className: string,
    memberName: string
): LiteralHit | undefined {
    const entries = expando.get(`${className}.${memberName}`);
    if (!entries || entries.length === 0) return undefined;
    const e = entries[0];
    return {
        nameNode: e.nameNode,
        valueNode: e.initializer,
        propertySourceFile: e.sourceFile,
    };
}

export function makeContext(
    sourceFile: tslib.SourceFile,
    identifier: tslib.Identifier,
    memberName: string,
    hit: LiteralHit
): ThisMemberContext {
    return {
        sourceFile,
        identifier,
        memberName,
        property: hit.property,
        propertyNameNode: hit.nameNode,
        valueNode: hit.valueNode ?? extractValueNode(hit.property),
        propertySourceFile: hit.propertySourceFile,
    };
}
