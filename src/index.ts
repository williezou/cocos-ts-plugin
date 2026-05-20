import type * as tslib from "typescript/lib/tsserverlibrary";

function init(modules: { typescript: typeof tslib }) {
    const ts = modules.typescript;

    function create(info: tslib.server.PluginCreateInfo): tslib.LanguageService {
        const ls = info.languageService;
        const log = (msg: string) =>
            info.project.projectService.logger.info(`[cocos-ts-plugin] ${msg}`);

        log("plugin loaded");

        const proxy: tslib.LanguageService = Object.create(null);
        for (const k of Object.keys(ls) as Array<keyof tslib.LanguageService>) {
            const fn = ls[k] as any;
            proxy[k] = (...args: any[]) => fn.apply(ls, args);
        }

        proxy.getDefinitionAndBoundSpan = (fileName, position) => {
            const original = ls.getDefinitionAndBoundSpan(fileName, position);
            if (original && original.definitions && original.definitions.length > 0) {
                return original;
            }
            const ctx = locateThisMember(ts, ls, fileName, position);
            if (!ctx) return original;
            return buildDefinition(ts, ctx);
        };

        proxy.getDefinitionAtPosition = (fileName, position) => {
            const original = ls.getDefinitionAtPosition(fileName, position);
            if (original && original.length > 0) return original;
            const ctx = locateThisMember(ts, ls, fileName, position);
            if (!ctx) return undefined;
            const built = buildDefinition(ts, ctx);
            return built?.definitions as tslib.DefinitionInfo[] | undefined;
        };

        proxy.getQuickInfoAtPosition = (fileName, position) => {
            const original = ls.getQuickInfoAtPosition(fileName, position);
            if (original && !isAnyQuickInfo(ts, original)) return original;
            const ctx = locateThisMember(ts, ls, fileName, position);
            if (!ctx) return original;
            return buildQuickInfo(ts, ls, ctx) ?? original;
        };

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

    let cur: tslib.Node | undefined = parent.parent;
    while (cur) {
        if (
            ts.isObjectLiteralExpression(cur) &&
            cur.parent &&
            ts.isCallExpression(cur.parent) &&
            cur.parent.arguments[0] === cur &&
            isExtendCall(ts, cur.parent)
        ) {
            const property = findPropertyByName(ts, cur, memberName);
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
        if (position < node.getStart(sourceFile) || position >= node.getEnd()) {
            return undefined;
        }
        const child = ts.forEachChild(node, visit);
        return child ?? node;
    }
    return visit(sourceFile);
}

export = init;
