import type * as tslib from "typescript/lib/tsserverlibrary";

// ─── Resolution result types ─────────────────────────────────────────────────

export interface ThisMemberContext {
    sourceFile: tslib.SourceFile;
    identifier: tslib.Identifier;
    memberName: string;
    /** Optional — present for extend-literal hits, absent for synthesized hits from
     * the expando index. Builders should prefer the dedicated `propertyNameNode` and
     * `valueNode` fields below. */
    property?: tslib.ObjectLiteralElementLike;
    propertyNameNode: tslib.Node;
    /** Where the definition lives — may differ from `sourceFile` for inherited members. */
    propertySourceFile: tslib.SourceFile;
    /** RHS / initializer used by buildQuickInfo for type / signature inference. */
    valueNode?: tslib.Expression;
}

export interface ExtendMemberContext {
    sourceFile: tslib.SourceFile;
    memberName: string;
    identifier: tslib.Identifier;
}

export interface DottedAccessHit {
    sourceFile: tslib.SourceFile;
    identifier: tslib.Identifier;
    fullName: string;
    entry: ExpandoEntry;
}

export interface LiteralHit {
    /** Either an extend-literal property OR an expando-style synthetic hit. */
    property?: tslib.ObjectLiteralElementLike;
    nameNode: tslib.Node;
    valueNode?: tslib.Expression;
    propertySourceFile: tslib.SourceFile;
}

// ─── Index entry types ───────────────────────────────────────────────────────

export interface ExtendEntry {
    className: string;
    parentName: string | undefined;
    literal: tslib.ObjectLiteralExpression;
    sourceFile: tslib.SourceFile;
}

export type ExtendIndex = Map<string, ExtendEntry[]>;

export interface ExpandoEntry {
    fullName: string;                 // e.g., "ccui.Widget.TOUCH_ENDED"
    nameNode: tslib.Node;             // the `.name` part of the LHS PropertyAccess
    initializer: tslib.Expression;    // the RHS expression
    sourceFile: tslib.SourceFile;
}

export type ExpandoIndex = Map<string, ExpandoEntry[]>;

export interface PrototypeMember {
    className: string;
    memberName: string;
    nameNode: tslib.Node;
    initializer: tslib.Expression;
    sourceFile: tslib.SourceFile;
}

export interface PrototypeIndexEntry {
    members: PrototypeMember[];
    parents: string[];
}

export type PrototypeIndex = Map<string, PrototypeIndexEntry>;

export interface IdentifierEntry {
    name: string;                       // e.g., "shBeachMgr"
    nameNode: tslib.Node;
    initializer: tslib.Expression;      // RHS of the declaration
    sourceFile: tslib.SourceFile;
}

export type IdentifierIndex = Map<string, IdentifierEntry[]>;

// ─── Convenience getter aliases used throughout the resolver/providers ──────

export type GetExtendIndex = () => ExtendIndex;
export type GetExpandoIndex = () => ExpandoIndex;
export type GetProtoIndex = () => PrototypeIndex;
export type GetIdentifierIndex = () => IdentifierIndex;
