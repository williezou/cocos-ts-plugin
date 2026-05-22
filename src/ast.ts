import type * as tslib from "typescript/lib/tsserverlibrary";

// Generic AST helpers — no project-specific semantics here. These functions
// answer questions about JS source nodes that the resolver and indexer ask
// repeatedly: convert an expression to a dotted name, find the node at a
// position, walk extend literals, etc.

export function expressionToName(ts: typeof tslib, node: tslib.Node): string | undefined {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
        const parent = expressionToName(ts, node.expression);
        return parent ? `${parent}.${node.name.text}` : undefined;
    }
    return undefined;
}

export function isExtendCall(ts: typeof tslib, call: tslib.CallExpression): boolean {
    if (!ts.isPropertyAccessExpression(call.expression)) return false;
    return call.expression.name.text === "extend";
}

export function findPropertyByName(
    ts: typeof tslib,
    literal: tslib.ObjectLiteralExpression,
    name: string
): tslib.ObjectLiteralElementLike | undefined {
    for (const prop of literal.properties) {
        if (getPropertyName(ts, prop) === name) return prop;
    }
    return undefined;
}

export function getPropertyName(
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

/**
 * Returns the deepest AST node whose source range contains `position`. Position
 * == node.getEnd() is allowed so the cursor right after a token (e.g., just
 * before a `:` or `(`) still resolves to that token.
 */
export function findNodeAtPosition(
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

/**
 * Walks outward from `start` looking for the nearest object literal that's the
 * first argument of a `.extend(...)` call — i.e., the body of a cocos-style
 * class declaration.
 */
export function findEnclosingExtendLiteral(
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

/**
 * Walks outward from `start` through every enclosing function and returns the
 * first one whose placement identifies a class via the prototype/constructor
 * patterns. See `classNameForFunction` for the full pattern list.
 */
export function findPrototypeOwnerClass(
    ts: typeof tslib,
    start: tslib.Node
): string | undefined {
    let cur: tslib.Node | undefined = start.parent;
    while (cur) {
        if (
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isFunctionDeclaration(cur)
        ) {
            const name = classNameForFunction(ts, cur);
            if (name) return name;
        }
        cur = cur.parent;
    }
    return undefined;
}

export function classNameForFunction(
    ts: typeof tslib,
    fn: tslib.Node
): string | undefined {
    if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;

    const fp = fn.parent;
    if (!fp) return undefined;

    if (
        ts.isBinaryExpression(fp) &&
        fp.right === fn &&
        fp.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
        const lhs = fp.left;
        if (
            ts.isPropertyAccessExpression(lhs) &&
            ts.isPropertyAccessExpression(lhs.expression) &&
            lhs.expression.name.text === "prototype"
        ) {
            return expressionToName(ts, lhs.expression.expression);
        }
        const lhsName = expressionToName(ts, lhs);
        if (lhsName) return lhsName;
    }

    if (ts.isVariableDeclaration(fp) && fp.initializer === fn && ts.isIdentifier(fp.name)) {
        return fp.name.text;
    }

    if (ts.isPropertyAssignment(fp) && fp.initializer === fn) {
        const lit = fp.parent;
        if (lit && ts.isObjectLiteralExpression(lit)) {
            const assign = lit.parent;
            if (
                assign &&
                ts.isBinaryExpression(assign) &&
                assign.right === lit &&
                assign.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(assign.left) &&
                assign.left.name.text === "prototype"
            ) {
                return expressionToName(ts, assign.left.expression);
            }
            // let <Class> = <Parent>.extend({ <method>: function () { this.X = ... } })
            if (
                assign &&
                ts.isCallExpression(assign) &&
                assign.arguments[0] === lit &&
                isExtendCall(ts, assign)
            ) {
                const owner = getLiteralOwner(ts, lit);
                if (owner) return owner.className;
            }
        }
    }

    return undefined;
}

/**
 * For a literal `{...}` that's the first argument of an `.extend(...)` call,
 * returns `{ className, parentName }` derived from the surrounding assignment
 * (`let X = Y.extend(...)` -> className=X, parentName=Y).
 */
export function getLiteralOwner(
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

export function extractValueNode(
    prop: tslib.ObjectLiteralElementLike | undefined
): tslib.Expression | undefined {
    if (!prop) return undefined;
    if ((prop as any).initializer) return (prop as any).initializer;
    return undefined;
}

export function walkExtendLiterals(
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

export function walkThisAccesses(
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

/**
 * True if `id` (the trailing `.name` of a PropertyAccessExpression) is the LHS
 * of an assignment operator. Used to classify reference entries.
 */
export function isWriteAccessOfPropertyAccess(
    ts: typeof tslib,
    id: tslib.Identifier
): boolean {
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

/**
 * Returns the first non-nested `return <expr>` expression in `fn`'s body. Used
 * to infer the type a function produces when we know its identity but tsserver
 * has lost the connection (e.g., methods stored as `this.foo = function () {...}`).
 * Bails out on inner functions/arrows so we don't pick up returns from callbacks.
 */
export function findFirstReturnExpression(
    ts: typeof tslib,
    fn: tslib.Node
): tslib.Expression | undefined {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        return fn.body;
    }
    if (
        !ts.isFunctionExpression(fn) &&
        !ts.isFunctionDeclaration(fn) &&
        !ts.isArrowFunction(fn)
    ) {
        return undefined;
    }
    const body = (fn as tslib.FunctionLikeDeclaration).body;
    if (!body || !ts.isBlock(body)) return undefined;

    let result: tslib.Expression | undefined;
    function visit(node: tslib.Node): void {
        if (result) return;
        if (
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isFunctionDeclaration(node)
        ) {
            return; // don't descend into nested functions
        }
        if (ts.isReturnStatement(node) && node.expression) {
            result = node.expression;
            return;
        }
        ts.forEachChild(node, visit);
    }
    ts.forEachChild(body, visit);
    return result;
}

export function isFunctionLike(ts: typeof tslib, node: tslib.Node): boolean {
    return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

export function addToIndex<T>(index: Map<string, T[]>, key: string, entry: T): void {
    let arr = index.get(key);
    if (!arr) {
        arr = [];
        index.set(key, arr);
    }
    arr.push(entry);
}
