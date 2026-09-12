import type * as tslib from "typescript/lib/tsserverlibrary";
import {
    addToIndex,
    expressionToName,
    findPrototypeOwnerClass,
    getPropertyName,
    isExtendCall,
} from "./ast";
import { resolveReceiverToClass } from "./resolver";
import type {
    ExtendEntry,
    ExtendIndex,
    ExpandoIndex,
    IdentifierIndex,
    PrototypeIndex,
    PrototypeMember,
} from "./types";

/**
 * Builds the three indices the resolver consults at lookup time. Runs in two
 * passes:
 *   1. Walk every source file and record cocos extend assignments, expando
 *      assignments, and prototype/constructor patterns.
 *   2. Walk every source file again to find ad-hoc field assignments
 *      (`<receiver>.<field> = <init>`). Pass-1 indices let us resolve the
 *      receiver's class, then we fold the field into the expando index under
 *      `<class>.<field>`.
 */
export function buildIndices(
    ts: typeof tslib,
    program: tslib.Program
): {
    extend: ExtendIndex;
    expando: ExpandoIndex;
    proto: PrototypeIndex;
    identifier: IdentifierIndex;
} {
    const extend: ExtendIndex = new Map();
    const expando: ExpandoIndex = new Map();
    const proto: PrototypeIndex = new Map();
    const identifier: IdentifierIndex = new Map();
    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        collectEntries(ts, sf, extend, expando, proto, identifier);
    }
    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        collectAugmentedFields(ts, sf, extend, expando, proto);
    }
    return { extend, expando, proto, identifier };
}

function collectEntries(
    ts: typeof tslib,
    sf: tslib.SourceFile,
    extendIndex: ExtendIndex,
    expandoIndex: ExpandoIndex,
    protoIndex: PrototypeIndex,
    identifierIndex: IdentifierIndex
): void {
    function visit(node: tslib.Node): void {
        // let/var/const <name> = <expr>.extend({...})
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            isExtendCallWithLiteral(ts, node.initializer)
        ) {
            if (ts.isIdentifier(node.name)) {
                addToIndex(
                    extendIndex,
                    node.name.text,
                    makeExtendEntry(ts, node.name.text, node.initializer, sf)
                );
            }
        }
        // let/var/const <name> = <init>  -> identifier entry (for bare-identifier
        // receivers like `shBeachMgr.foo()`). We always record, even when the
        // initializer is also captured elsewhere — resolveReceiverToClass will
        // try interpretations in order.
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isIdentifier(node.name)
        ) {
            addToIndex(identifierIndex, node.name.text, {
                name: node.name.text,
                nameNode: node.name,
                initializer: node.initializer,
                sourceFile: sf,
            });

            // `var Config = { value: ... }` can still be typed as `any` in
            // legacy JS projects (for example because of an explicit JSDoc
            // annotation or another declaration of Config). In that case
            // tsserver loses both the property type and its definition site.
            // Index the literal's members just like `Namespace.Config = {}`.
            collectObjectLiteralInitializers(
                ts,
                node.name.text,
                node.initializer,
                sf,
                expandoIndex
            );
        }
        // `this.X = <value>` inside a constructor-bound function -> proto member
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(node.left) &&
            node.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            const owner = findPrototypeOwnerClass(ts, node);
            if (owner) {
                addProtoMember(protoIndex, {
                    className: owner,
                    memberName: node.left.name.text,
                    nameNode: node.left.name,
                    initializer: node.right,
                    sourceFile: sf,
                });
            }
        }
        // <LHS> = <RHS>
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            collectPrototypeEntry(ts, node, sf, protoIndex);

            const lhsName = expressionToName(ts, node.left);
            if (lhsName) {
                if (isExtendCallWithLiteral(ts, node.right)) {
                    // X = Y.extend({...})  -> extend entry
                    addToIndex(
                        extendIndex,
                        lhsName,
                        makeExtendEntry(ts, lhsName, node.right, sf)
                    );
                } else if (
                    ts.isPropertyAccessExpression(node.left) &&
                    lhsName.includes(".")
                ) {
                    // a.b.c = <value>  -> expando entry (only when LHS is a dotted access)
                    addToIndex(expandoIndex, lhsName, {
                        fullName: lhsName,
                        nameNode: node.left.name,
                        initializer: node.right,
                        sourceFile: sf,
                    });
                }

                // `a.b = { foo: ... }` and `Config = { foo: ... }` -> index
                // each member. The latter is common when a global config is
                // declared first and populated later.
                collectObjectLiteralInitializers(ts, lhsName, node.right, sf, expandoIndex);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
}

/**
 * Finds object-literal alternatives used to initialize a legacy global.
 * Besides a direct `{ ... }`, cocos projects commonly use the idempotent form
 * `let Config = Config || { ... }` so the file can safely be evaluated twice.
 */
function collectObjectLiteralInitializers(
    ts: typeof tslib,
    ownerName: string,
    initializer: tslib.Expression,
    sf: tslib.SourceFile,
    expandoIndex: ExpandoIndex
): void {
    if (ts.isParenthesizedExpression(initializer)) {
        collectObjectLiteralInitializers(
            ts,
            ownerName,
            initializer.expression,
            sf,
            expandoIndex
        );
        return;
    }
    if (ts.isObjectLiteralExpression(initializer)) {
        collectObjectLiteralMembers(ts, ownerName, initializer, sf, expandoIndex);
        return;
    }
    if (ts.isBinaryExpression(initializer)) {
        const op = initializer.operatorToken.kind;
        if (
            op === ts.SyntaxKind.BarBarToken ||
            op === ts.SyntaxKind.QuestionQuestionToken
        ) {
            collectObjectLiteralInitializers(ts, ownerName, initializer.left, sf, expandoIndex);
            collectObjectLiteralInitializers(ts, ownerName, initializer.right, sf, expandoIndex);
        }
        return;
    }
    if (ts.isConditionalExpression(initializer)) {
        collectObjectLiteralInitializers(ts, ownerName, initializer.whenTrue, sf, expandoIndex);
        collectObjectLiteralInitializers(ts, ownerName, initializer.whenFalse, sf, expandoIndex);
    }
}

/** Flattens the direct members of an object literal into the expando index. */
function collectObjectLiteralMembers(
    ts: typeof tslib,
    ownerName: string,
    literal: tslib.ObjectLiteralExpression,
    sf: tslib.SourceFile,
    expandoIndex: ExpandoIndex
): void {
    for (const prop of literal.properties) {
        const propName = getPropertyName(ts, prop);
        const propNameNode = (prop as any).name as tslib.Node | undefined;
        if (!propName || !propNameNode) continue;
        const init = ts.isPropertyAssignment(prop)
            ? prop.initializer
            : ts.isMethodDeclaration(prop)
            ? (prop as unknown as tslib.Expression)
            : undefined;
        if (!init) continue;
        const fullName = `${ownerName}.${propName}`;
        addToIndex(expandoIndex, fullName, {
            fullName,
            nameNode: propNameNode,
            initializer: init,
            sourceFile: sf,
        });
        // Flatten nested config objects too, so chains such as
        // `Config.bundle.bundleNames.poster` can resolve every segment.
        collectObjectLiteralInitializers(ts, fullName, init, sf, expandoIndex);
    }
}

/**
 * Pass 2: ad-hoc field assignments such as `this._spineAni.nodeDelay = new cc.Node()`.
 * We need pass-1 indices to resolve the receiver's class. Found fields are folded
 * into the expando index so the chain-walker picks them up uniformly.
 */
function collectAugmentedFields(
    ts: typeof tslib,
    sf: tslib.SourceFile,
    extend: ExtendIndex,
    expando: ExpandoIndex,
    proto: PrototypeIndex
): void {
    function visit(node: tslib.Node): void {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(node.left) &&
            ts.isPropertyAccessExpression(node.left.expression)
        ) {
            const receiver = node.left.expression;
            const fieldName = node.left.name.text;
            const className = resolveReceiverToClass(
                ts,
                () => extend,
                () => proto,
                receiver,
                () => expando
            );
            if (className) {
                const key = `${className}.${fieldName}`;
                addToIndex(expando, key, {
                    fullName: key,
                    nameNode: node.left.name,
                    initializer: node.right,
                    sourceFile: sf,
                });
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
}

/**
 * Detects classical-prototype patterns and records them in `protoIndex`:
 *   - <Class>.prototype.<member> = <value>   -> single member
 *   - <Class>.prototype = <Other>.prototype | new Other() | Object.create(...) -> parent link
 *   - <Class>.prototype = { ...literal... }   -> each property becomes a member
 */
function collectPrototypeEntry(
    ts: typeof tslib,
    node: tslib.BinaryExpression,
    sf: tslib.SourceFile,
    protoIndex: PrototypeIndex
): void {
    if (!ts.isPropertyAccessExpression(node.left)) return;
    const lhs = node.left;

    // <X>.prototype.<member> = <expr>
    if (ts.isPropertyAccessExpression(lhs.expression) && lhs.expression.name.text === "prototype") {
        const className = expressionToName(ts, lhs.expression.expression);
        if (!className) return;
        addProtoMember(protoIndex, {
            className,
            memberName: lhs.name.text,
            nameNode: lhs.name,
            initializer: node.right,
            sourceFile: sf,
        });
        return;
    }

    // <X>.prototype = ...
    if (lhs.name.text === "prototype") {
        const className = expressionToName(ts, lhs.expression);
        if (!className) return;

        const parent = extractPrototypeParent(ts, node.right);
        if (parent) addProtoParent(protoIndex, className, parent);

        if (ts.isObjectLiteralExpression(node.right)) {
            for (const prop of node.right.properties) {
                const memberName = getPropertyName(ts, prop);
                const nameNode = (prop as any).name as tslib.Node | undefined;
                if (!memberName || !nameNode) continue;
                const init = ts.isPropertyAssignment(prop)
                    ? prop.initializer
                    : ts.isMethodDeclaration(prop)
                    ? (prop as unknown as tslib.Expression)
                    : undefined;
                if (!init) continue;
                addProtoMember(protoIndex, {
                    className,
                    memberName,
                    nameNode,
                    initializer: init,
                    sourceFile: sf,
                });
            }
        }
    }
}

function extractPrototypeParent(
    ts: typeof tslib,
    expr: tslib.Expression
): string | undefined {
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === "prototype") {
        return expressionToName(ts, expr.expression);
    }
    if (ts.isNewExpression(expr)) {
        return expressionToName(ts, expr.expression);
    }
    // Object.create(<Other>.prototype)
    if (
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.name.text === "create" &&
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "Object" &&
        expr.arguments.length > 0
    ) {
        const arg = expr.arguments[0];
        if (ts.isPropertyAccessExpression(arg) && arg.name.text === "prototype") {
            return expressionToName(ts, arg.expression);
        }
    }
    return undefined;
}

function addProtoMember(index: PrototypeIndex, m: PrototypeMember): void {
    let entry = index.get(m.className);
    if (!entry) {
        entry = { members: [], parents: [] };
        index.set(m.className, entry);
    }
    entry.members.push(m);
}

function addProtoParent(
    index: PrototypeIndex,
    className: string,
    parentName: string
): void {
    let entry = index.get(className);
    if (!entry) {
        entry = { members: [], parents: [] };
        index.set(className, entry);
    }
    if (!entry.parents.includes(parentName)) entry.parents.push(parentName);
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

function makeExtendEntry(
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
