import type * as tslib from "typescript/lib/tsserverlibrary";
import {
    expressionToName,
    extractValueNode,
    findEnclosingExtendLiteral,
    findFirstReturnExpression,
    findNodeAtPosition,
    findPrototypeOwnerClass,
    findPropertyByName,
    getLiteralOwner,
    isExtendCall,
    isFunctionLike,
} from "./ast";
import type {
    DottedAccessHit,
    ExpandoIndex,
    ExtendIndex,
    ExtendMemberContext,
    GetExpandoIndex,
    GetExtendIndex,
    GetIdentifierIndex,
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
    const literal = findEnclosingExtendLiteral(ts, parent);
    if (!literal) return undefined;
    if (!isExtendThisReceiver(ts, parent.expression, parent, literal)) return undefined;

    const memberName = node.text;
    const hit = lookupInLiteralAndChain(ts, getIndex, literal, memberName, getExpandoIndex);
    if (!hit) return undefined;
    return makeContext(sourceFile, node, memberName, hit);
}

/**
 * Accepts both a direct `this.member` access and the legacy cocos pattern
 * `let self = this; ... self.member` used from a nested callback.  The alias
 * must belong to the same extend-literal method; a same-named variable in a
 * nested function shadows an outer alias.
 */
function isExtendThisReceiver(
    ts: typeof tslib,
    receiver: tslib.Expression,
    access: tslib.PropertyAccessExpression,
    literal: tslib.ObjectLiteralExpression
): boolean {
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isIdentifier(receiver)) return false;

    const alias = receiver.text;
    const accessStart = access.getStart();
    let current: tslib.Node | undefined = access.parent;

    while (current && current !== literal) {
        if (
            ts.isFunctionDeclaration(current) ||
            ts.isFunctionExpression(current) ||
            ts.isArrowFunction(current) ||
            ts.isMethodDeclaration(current)
        ) {
            const binding = findAliasBindingInFunction(ts, current, alias, accessStart);
            if (binding !== undefined) return binding;

            if (isExtendMemberFunction(ts, current, literal)) return false;
        }
        current = current.parent;
    }
    return false;
}

function isExtendMemberFunction(
    ts: typeof tslib,
    fn: tslib.FunctionDeclaration | tslib.FunctionExpression | tslib.ArrowFunction | tslib.MethodDeclaration,
    literal: tslib.ObjectLiteralExpression
): boolean {
    if (ts.isMethodDeclaration(fn)) return fn.parent === literal;
    return !!(
        fn.parent &&
        ts.isPropertyAssignment(fn.parent) &&
        fn.parent.initializer === fn &&
        fn.parent.parent === literal
    );
}

/** Returns true for `<alias> = this`, false for a shadowing binding, and
 * undefined when this function scope has no binding for the alias. */
function findAliasBindingInFunction(
    ts: typeof tslib,
    fn: tslib.FunctionDeclaration | tslib.FunctionExpression | tslib.ArrowFunction | tslib.MethodDeclaration,
    alias: string,
    beforePosition: number
): boolean | undefined {
    for (const parameter of fn.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === alias) return false;
    }

    let latestStart = -1;
    let latestIsThis: boolean | undefined;
    const visit = (node: tslib.Node): void => {
        if (node !== fn && (
            ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node)
        )) {
            return;
        }
        const start = node.getStart();
        if (start >= beforePosition) return;

        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === alias &&
            start > latestStart
        ) {
            latestStart = start;
            latestIsThis = node.initializer?.kind === ts.SyntaxKind.ThisKeyword;
        } else if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            node.left.text === alias &&
            start > latestStart
        ) {
            latestStart = start;
            latestIsThis = node.right.kind === ts.SyntaxKind.ThisKeyword;
        }
        ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    return latestIsThis;
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
    getIdentifierIndex: GetIdentifierIndex,
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
        ts, getIndex, getProtoIndex, receiver, getExpandoIndex, getIdentifierIndex
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
    // Fallback A: member lives directly as an expando on `className`.
    const onClass = expandoHit(getExpandoIndex(), className, memberName);
    if (onClass) return makeContext(sourceFile, node, memberName, onClass);
    // Fallback B: `className` is a prototype/constructor class (no extend literal),
    // walk its prototype chain.
    const protoMember = lookupProtoMember(getProtoIndex(), className, memberName);
    if (protoMember) {
        return makeContext(sourceFile, node, memberName, {
            nameNode: protoMember.nameNode,
            valueNode: protoMember.initializer,
            propertySourceFile: protoMember.sourceFile,
        });
    }
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

    let fullName: string | undefined;
    if (parent.name === node) {
        if (parent.expression.kind === ts.SyntaxKind.ThisKeyword) return undefined;
        fullName = expressionToName(ts, parent);
    } else if (parent.expression === node) {
        // Cursor is on the receiver in `enumValue.member`. Object-literal
        // assignments are indexed under their bare owner name as well.
        fullName = node.text;
    } else {
        return undefined;
    }
    if (!fullName) return undefined;

    const entries = getIndex().get(fullName);
    if (!entries || entries.length === 0) return undefined;

    return { sourceFile, identifier: node, fullName, entry: entries[0] };
}

/**
 * Resolves either side of an expando-style member reference:
 *   - a use such as `Config.reset()`
 *   - the `reset` declaration inside `Config = { reset: function () {} }`
 *
 * The reverse lookup for declarations is intentionally limited to dotted
 * entries, excluding the synthetic entry for the root object itself.
 */
export function locateExpandoMember(
    ts: typeof tslib,
    ls: tslib.LanguageService,
    getIndex: GetExpandoIndex,
    fileName: string,
    position: number
): DottedAccessHit | undefined {
    const use = locateDottedAccess(ts, ls, getIndex, fileName, position);
    if (use?.fullName.includes(".") && !use.fullName.includes(".prototype.")) return use;

    const program = ls.getProgram();
    if (!program) return undefined;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return undefined;
    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node || !ts.isIdentifier(node)) return undefined;

    for (const [fullName, entries] of getIndex()) {
        if (!fullName.includes(".") || fullName.includes(".prototype.")) continue;
        for (const entry of entries) {
            if (entry.sourceFile === sourceFile && entry.nameNode === node) {
                return { sourceFile, identifier: node, fullName, entry };
            }
        }
    }
    return undefined;
}

/**
 * Resolves a classical-prototype member from either its declaration or a use
 * inside one of the class's methods. `findPrototypeOwnerClass` deliberately
 * walks through nested callbacks, so aliases such as `self = this` work too.
 */
export function locatePrototypeMember(
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

    const index = getProtoIndex();

    // Declaration: `<Class>.prototype.<member> = ...` or a member in a
    // `<Class>.prototype = { ... }` literal.
    for (const entry of index.values()) {
        for (const member of entry.members) {
            if (member.sourceFile === sourceFile && member.nameNode === node) {
                return protoMemberHit(sourceFile, node, member);
            }
        }
    }

    // Use from a class-owned function: `this.<member>` or `self.<member>` in a
    // nested callback. Only accept names that resolve on that prototype chain.
    const parent = node.parent;
    if (!parent || !ts.isPropertyAccessExpression(parent) || parent.name !== node) {
        return undefined;
    }
    const ownerClass = findPrototypeOwnerClass(ts, parent);
    if (!ownerClass) return undefined;
    const member = lookupProtoMember(index, ownerClass, node.text);
    return member ? protoMemberHit(sourceFile, node, member) : undefined;
}

function protoMemberHit(
    sourceFile: tslib.SourceFile,
    identifier: tslib.Identifier,
    member: PrototypeMember
): DottedAccessHit {
    const fullName = `${member.className}.${member.memberName}`;
    return {
        sourceFile,
        identifier,
        fullName,
        entry: {
            fullName,
            nameNode: member.nameNode,
            initializer: member.initializer,
            sourceFile: member.sourceFile,
        },
    };
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
    getExpandoIndex?: GetExpandoIndex,
    getIdentifierIndex?: GetIdentifierIndex
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
                const cls = extractClassFromInitializer(ts, hit.valueNode, getExtendIndex, getProtoIndex);
                if (cls) return cls;
            }
        }

        // A2: prototype / constructor-body assignments (`this._spineAni = ...`)
        const ownerClass = findPrototypeOwnerClass(ts, receiver);
        if (ownerClass) {
            const members = collectProtoMembers(getProtoIndex(), ownerClass, memberName);
            for (const m of members) {
                const cls = extractClassFromInitializer(ts, m.initializer, getExtendIndex, getProtoIndex);
                if (cls) return cls;
            }
        }
        return undefined;
    }

    // Case B: dotted name that matches a known class directly
    const direct = expressionToName(ts, receiver);
    if (direct) {
        const found = lookupClassName(getExtendIndex(), direct, getProtoIndex());
        if (found) return found;
    }

    // Case C: multi-level chain — `<sub>.<field>` where <sub> isn't `this`.
    if (ts.isPropertyAccessExpression(receiver)) {
        const subClass = resolveReceiverToClass(
            ts, getExtendIndex, getProtoIndex, receiver.expression,
            getExpandoIndex, getIdentifierIndex
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
                    const cls = extractClassFromInitializer(ts, hit.valueNode, getExtendIndex, getProtoIndex);
                    if (cls) return cls;
                }
            }
        }
        if (getExpandoIndex) {
            const eHit = expandoHit(getExpandoIndex(), subClass, fieldName);
            if (eHit?.valueNode) {
                const cls = extractClassFromInitializer(ts, eHit.valueNode, getExtendIndex, getProtoIndex);
                if (cls) return cls;
            }
        }
        return undefined;
    }

    // Case D: bare identifier — resolve via the top-level identifier index
    // (`let shBeachMgr = new ShanghaiBeachManager()` etc).
    if (ts.isIdentifier(receiver) && getIdentifierIndex) {
        const entries = getIdentifierIndex().get(receiver.text);
        if (entries) {
            for (const entry of entries) {
                const cls = extractClassFromInitializer(ts, entry.initializer, getExtendIndex, getProtoIndex);
                if (cls) return cls;
            }
        }
    }

    // Case E: <callee>(...) — receiver is a call. Find the function being
    // called, then recursively resolve the class of its first `return` value.
    if (ts.isCallExpression(receiver)) {
        const valueNode = findReceiverValueNode(
            ts, receiver.expression, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex
        );
        if (valueNode && isFunctionLike(ts, valueNode)) {
            const retExpr = findFirstReturnExpression(ts, valueNode);
            if (retExpr) {
                return resolveReceiverToClass(
                    ts, getExtendIndex, getProtoIndex, retExpr, getExpandoIndex, getIdentifierIndex
                );
            }
        }
    }
    return undefined;
}

/**
 * Resolves a receiver expression to the value AST node assigned to it (typically
 * a FunctionExpression for callable lookups). Mirrors the lookup branches of
 * `resolveReceiverToClass` but returns the raw RHS instead of running it through
 * `extractClassFromInitializer`. Used by Case E to dig into method bodies.
 */
function findReceiverValueNode(
    ts: typeof tslib,
    receiver: tslib.Expression,
    getExtendIndex: GetExtendIndex,
    getProtoIndex: GetProtoIndex,
    getExpandoIndex?: GetExpandoIndex,
    getIdentifierIndex?: GetIdentifierIndex
): tslib.Expression | undefined {
    // `this.<member>`
    if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        const memberName = receiver.name.text;
        const literal = findEnclosingExtendLiteral(ts, receiver);
        if (literal) {
            const hit = lookupInLiteralAndChain(
                ts, getExtendIndex, literal, memberName, getExpandoIndex
            );
            if (hit?.valueNode) return hit.valueNode;
        }
        const ownerClass = findPrototypeOwnerClass(ts, receiver);
        if (ownerClass) {
            const members = collectProtoMembers(getProtoIndex(), ownerClass, memberName);
            if (members.length > 0) return members[0].initializer;
        }
        return undefined;
    }

    // `<sub>.<field>` (non-this chain)
    if (ts.isPropertyAccessExpression(receiver)) {
        const subClass = resolveReceiverToClass(
            ts, getExtendIndex, getProtoIndex, receiver.expression, getExpandoIndex, getIdentifierIndex
        );
        if (!subClass) return undefined;
        const fieldName = receiver.name.text;

        const entries = getExtendIndex().get(subClass);
        if (entries) {
            for (const entry of entries) {
                const hit = lookupInLiteralAndChain(
                    ts, getExtendIndex, entry.literal, fieldName, getExpandoIndex
                );
                if (hit?.valueNode) return hit.valueNode;
            }
        }
        if (getExpandoIndex) {
            const eHit = expandoHit(getExpandoIndex(), subClass, fieldName);
            if (eHit?.valueNode) return eHit.valueNode;
        }
        const protoMember = lookupProtoMember(getProtoIndex(), subClass, fieldName);
        if (protoMember) return protoMember.initializer;
        return undefined;
    }

    // Bare identifier
    if (ts.isIdentifier(receiver) && getIdentifierIndex) {
        const entries = getIdentifierIndex().get(receiver.text);
        if (entries && entries[0]) return entries[0].initializer;
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
    getExtendIndex: GetExtendIndex,
    getProtoIndex?: GetProtoIndex
): string | undefined {
    if (!init) return undefined;
    if (init.kind === ts.SyntaxKind.NullKeyword) return undefined;
    if (init.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;

    // Unwrap `(expr)` and short-circuit guards like `x || new Foo()`, `x ?? new Foo()`.
    if (ts.isParenthesizedExpression(init)) {
        return extractClassFromInitializer(ts, init.expression, getExtendIndex, getProtoIndex);
    }
    if (ts.isBinaryExpression(init)) {
        const op = init.operatorToken.kind;
        if (
            op === ts.SyntaxKind.BarBarToken ||
            op === ts.SyntaxKind.QuestionQuestionToken
        ) {
            return (
                extractClassFromInitializer(ts, init.right, getExtendIndex, getProtoIndex) ??
                extractClassFromInitializer(ts, init.left, getExtendIndex, getProtoIndex)
            );
        }
    }
    if (ts.isConditionalExpression(init)) {
        return (
            extractClassFromInitializer(ts, init.whenTrue, getExtendIndex, getProtoIndex) ??
            extractClassFromInitializer(ts, init.whenFalse, getExtendIndex, getProtoIndex)
        );
    }

    const direct = expressionToName(ts, init);
    if (direct) {
        const found = lookupClassName(getExtendIndex(), direct, getProtoIndex?.());
        if (found) return found;
    }
    if (ts.isNewExpression(init)) {
        const ctorName = expressionToName(ts, init.expression);
        if (ctorName) {
            const found = lookupClassName(getExtendIndex(), ctorName, getProtoIndex?.());
            if (found) return found;
        }
    }
    if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)) {
        const receiverName = expressionToName(ts, init.expression.expression);
        if (receiverName) {
            const found = lookupClassName(getExtendIndex(), receiverName, getProtoIndex?.());
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
export function lookupClassName(
    index: ExtendIndex,
    name: string,
    protoIndex?: PrototypeIndex
): string | undefined {
    const exists = (n: string): boolean => index.has(n) || (protoIndex?.has(n) ?? false);
    if (exists(name)) return name;
    const dot = name.lastIndexOf(".");
    if (dot < 0) {
        const cap = name[0]?.toUpperCase() + name.slice(1);
        return exists(cap) ? cap : undefined;
    }
    const head = name.substring(0, dot + 1);
    const tail = name.substring(dot + 1);
    if (!tail) return undefined;
    const cap = head + tail[0].toUpperCase() + tail.slice(1);
    return exists(cap) ? cap : undefined;
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
