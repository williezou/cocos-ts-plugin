import type * as tslib from "typescript/lib/tsserverlibrary";
import { buildIndices } from "./indexer";
import {
    locateChainedMember,
    locateDottedAccess,
    locateExpandoMember,
    locatePrototypeMember,
    locateThisMember,
    locateThisProtoMember,
    resolveExtendMember,
} from "./resolver";
import {
    buildCallHierarchyItem,
    buildDefinition,
    buildDefinitionFromExpando,
    buildQuickInfo,
    buildQuickInfoForThis,
    buildQuickInfoFromExpando,
    collectMemberCompletions,
    collectExpandoImplementations,
    collectExpandoIncomingCalls,
    collectPrototypeImplementations,
    collectPrototypeIncomingCalls,
    dedupeReferences,
    isWeakQuickInfo,
    mergeExpandoReferences,
    mergeImplementations,
    mergeReferences,
    scanExpandoReferences,
    scanExtendReferences,
    scanPrototypeReferences,
} from "./providers";
import type {
    ExpandoIndex,
    ExtendIndex,
    IdentifierIndex,
    PrototypeIndex,
} from "./types";

/**
 * TypeScript Language Service plugin for cocos2d-x / cocos2d-html5 JS code.
 *
 * The plugin proxies the LanguageService and augments tsserver's native
 * answers for `cc.Class.extend({...})` and related cocos class patterns. All
 * project-specific resolution lives in ./resolver.ts (lookup logic) and
 * ./providers.ts (output formatting); ./indexer.ts builds the indices once
 * per ts.Program and caches them here in the create() closure.
 */
function init(modules: { typescript: typeof tslib }) {
    const ts = modules.typescript;

    function create(info: tslib.server.PluginCreateInfo): tslib.LanguageService {
        const ls = info.languageService;
        const log = (msg: string) =>
            info.project.projectService.logger.info(`[cocos-ts-plugin] ${msg}`);

        log("plugin loaded v0.1.19");

        // ─── Index cache ─────────────────────────────────────────────────────
        let cachedIndex: {
            program: tslib.Program;
            extend: ExtendIndex;
            expando: ExpandoIndex;
            proto: PrototypeIndex;
            identifier: IdentifierIndex;
        } | undefined;

        function ensureIndex(): void {
            const program = ls.getProgram();
            if (!program) {
                cachedIndex = {
                    program: program!,
                    extend: new Map(),
                    expando: new Map(),
                    proto: new Map(),
                    identifier: new Map(),
                };
                return;
            }
            if (cachedIndex && cachedIndex.program === program) return;
            const started = Date.now();
            const { extend, expando, proto, identifier } = buildIndices(ts, program);
            log(
                `indices built: ${extend.size} extend, ${expando.size} expando, ${proto.size} proto, ${identifier.size} id, ${Date.now() - started}ms`
            );
            cachedIndex = { program, extend, expando, proto, identifier };
        }

        const getExtendIndex = (): ExtendIndex => {
            ensureIndex();
            return cachedIndex!.extend;
        };
        const getExpandoIndex = (): ExpandoIndex => {
            ensureIndex();
            return cachedIndex!.expando;
        };
        const getProtoIndex = (): PrototypeIndex => {
            ensureIndex();
            return cachedIndex!.proto;
        };
        const getIdentifierIndex = (): IdentifierIndex => {
            ensureIndex();
            return cachedIndex!.identifier;
        };

        // ─── Safety wrapper ──────────────────────────────────────────────────
        // If any of our overrides throws, fall back to tsserver's native answer
        // so the editor never goes dark because of a plugin bug.
        const guard = <T>(name: string, fn: () => T, fallback: T): T => {
            try {
                return fn();
            } catch (e: any) {
                log(`error in ${name}: ${e && e.stack ? e.stack : e}`);
                return fallback;
            }
        };

        // ─── Proxy: start by wrapping every LS method as a pass-through,
        // then override just the ones we provide augmentations for.
        const proxy: tslib.LanguageService = Object.create(null);
        for (const k of Object.keys(ls) as Array<keyof tslib.LanguageService>) {
            const fn = ls[k] as any;
            proxy[k] = (...args: any[]) => fn.apply(ls, args);
        }

        proxy.getDefinitionAndBoundSpan = (fileName, position) =>
            guard("getDefinitionAndBoundSpan", () => {
                const original = ls.getDefinitionAndBoundSpan(fileName, position);
                if (original?.definitions?.length) return original;

                const ctx =
                    locateThisMember(ts, ls, getExtendIndex, getExpandoIndex, fileName, position) ??
                    locateChainedMember(
                        ts, ls, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex, fileName, position
                    );
                if (ctx) {
                    log(`def: resolved ${ctx.memberName} -> ${ctx.propertySourceFile.fileName}:${ctx.propertyNameNode.getStart(ctx.propertySourceFile)}`);
                    return buildDefinition(ts, ctx);
                }
                const proto = locateThisProtoMember(ts, ls, getProtoIndex, fileName, position);
                if (proto) {
                    log(`def: resolved ${proto.fullName} -> ${proto.entry.sourceFile.fileName}:${proto.entry.nameNode.getStart(proto.entry.sourceFile)}`);
                    return buildDefinitionFromExpando(ts, proto);
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

                const ctx =
                    locateThisMember(ts, ls, getExtendIndex, getExpandoIndex, fileName, position) ??
                    locateChainedMember(
                        ts, ls, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex, fileName, position
                    );
                if (ctx) {
                    return buildDefinition(ts, ctx).definitions as tslib.DefinitionInfo[];
                }
                const proto = locateThisProtoMember(ts, ls, getProtoIndex, fileName, position);
                if (proto) {
                    return buildDefinitionFromExpando(ts, proto).definitions as tslib.DefinitionInfo[];
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
                if (original && !isWeakQuickInfo(ts, original)) return original;

                const ctx =
                    locateThisMember(ts, ls, getExtendIndex, getExpandoIndex, fileName, position) ??
                    locateChainedMember(
                        ts, ls, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex, fileName, position
                    );
                if (ctx) {
                    log(`hover: resolving ${ctx.memberName}`);
                    return buildQuickInfo(ts, ls, ctx, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex) ?? original;
                }
                const proto = locateThisProtoMember(ts, ls, getProtoIndex, fileName, position);
                if (proto) {
                    log(`hover: resolving ${proto.fullName}`);
                    return buildQuickInfoFromExpando(ts, ls, proto, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex) ?? original;
                }
                const dotted = locateDottedAccess(ts, ls, getExpandoIndex, fileName, position);
                if (dotted) {
                    log(`hover: resolving ${dotted.fullName}`);
                    return buildQuickInfoFromExpando(ts, ls, dotted, getExtendIndex, getProtoIndex, getExpandoIndex, getIdentifierIndex) ?? original;
                }
                const thisQi = buildQuickInfoForThis(ts, ls, fileName, position);
                if (thisQi) {
                    log("hover: resolving this keyword in extend literal");
                    return thisQi;
                }
                return original;
            }, ls.getQuickInfoAtPosition(fileName, position));

        proxy.findReferences = (fileName, position) =>
            guard("findReferences", () => {
                const original = ls.findReferences(fileName, position);
                const memberCtx = resolveExtendMember(ts, ls, fileName, position);
                if (memberCtx) {
                    const extra = scanExtendReferences(ts, ls, memberCtx.memberName);
                    log(`refs: ${memberCtx.memberName} -> tsserver=${original?.reduce((n, s) => n + s.references.length, 0) ?? 0}, scanned=${extra.length}`);
                    return mergeReferences(ts, original, extra, memberCtx);
                }

                const protoCtx = locatePrototypeMember(
                    ts, ls, getProtoIndex, fileName, position
                );
                if (protoCtx) {
                    const dot = protoCtx.fullName.lastIndexOf(".");
                    const extra = scanPrototypeReferences(
                        ts,
                        ls,
                        getExtendIndex,
                        getProtoIndex,
                        getExpandoIndex,
                        getIdentifierIndex,
                        protoCtx.fullName.substring(0, dot),
                        protoCtx.fullName.substring(dot + 1)
                    );
                    log(`refs: ${protoCtx.fullName} -> tsserver=${original?.reduce((n, s) => n + s.references.length, 0) ?? 0}, scanned=${extra.length}`);
                    return mergeExpandoReferences(ts, original, extra, protoCtx);
                }

                const expandoCtx = locateExpandoMember(
                    ts, ls, getExpandoIndex, fileName, position
                );
                if (expandoCtx) {
                    const extra = scanExpandoReferences(
                        ts, ls, getExpandoIndex, expandoCtx.fullName
                    );
                    log(`refs: ${expandoCtx.fullName} -> tsserver=${original?.reduce((n, s) => n + s.references.length, 0) ?? 0}, scanned=${extra.length}`);
                    return mergeExpandoReferences(ts, original, extra, expandoCtx);
                }

                log(`refs: no plugin member context at ${fileName}:${position}`);
                return original;
            }, ls.findReferences(fileName, position));

        proxy.getReferencesAtPosition = (fileName, position) =>
            guard("getReferencesAtPosition", () => {
                const original = ls.getReferencesAtPosition(fileName, position) ?? [];
                const memberCtx = resolveExtendMember(ts, ls, fileName, position);
                if (memberCtx) {
                    const extra = scanExtendReferences(ts, ls, memberCtx.memberName);
                    return dedupeReferences([...original, ...extra]);
                }
                const protoCtx = locatePrototypeMember(
                    ts, ls, getProtoIndex, fileName, position
                );
                if (protoCtx) {
                    const dot = protoCtx.fullName.lastIndexOf(".");
                    const extra = scanPrototypeReferences(
                        ts,
                        ls,
                        getExtendIndex,
                        getProtoIndex,
                        getExpandoIndex,
                        getIdentifierIndex,
                        protoCtx.fullName.substring(0, dot),
                        protoCtx.fullName.substring(dot + 1)
                    );
                    return dedupeReferences([...original, ...extra]);
                }
                const expandoCtx = locateExpandoMember(
                    ts, ls, getExpandoIndex, fileName, position
                );
                if (expandoCtx) {
                    const extra = scanExpandoReferences(
                        ts, ls, getExpandoIndex, expandoCtx.fullName
                    );
                    return dedupeReferences([...original, ...extra]);
                }
                return original.length ? original : undefined;
            }, ls.getReferencesAtPosition(fileName, position));

        proxy.getImplementationAtPosition = (fileName, position) =>
            guard("getImplementationAtPosition", () => {
                const original = ls.getImplementationAtPosition(fileName, position);
                const protoCtx = locatePrototypeMember(
                    ts, ls, getProtoIndex, fileName, position
                );
                if (protoCtx) {
                    const dot = protoCtx.fullName.lastIndexOf(".");
                    const extra = collectPrototypeImplementations(
                        ts,
                        getProtoIndex,
                        protoCtx.fullName.substring(0, dot),
                        protoCtx.fullName.substring(dot + 1)
                    );
                    log(`impl: ${protoCtx.fullName} -> tsserver=${original?.length ?? 0}, indexed=${extra.length}`);
                    return mergeImplementations(original, extra);
                }

                const expandoCtx = locateExpandoMember(
                    ts, ls, getExpandoIndex, fileName, position
                );
                if (expandoCtx) {
                    const extra = collectExpandoImplementations(
                        ts, getExpandoIndex, expandoCtx.fullName
                    );
                    log(`impl: ${expandoCtx.fullName} -> tsserver=${original?.length ?? 0}, indexed=${extra.length}`);
                    return mergeImplementations(original, extra);
                }
                return original;
            }, ls.getImplementationAtPosition(fileName, position));

        if (ls.prepareCallHierarchy && ls.provideCallHierarchyIncomingCalls) {
            proxy.prepareCallHierarchy = (fileName, position) =>
                guard("prepareCallHierarchy", () => {
                    const original = ls.prepareCallHierarchy(fileName, position);
                    if (original && (!Array.isArray(original) || original.length > 0)) {
                        return original;
                    }
                    const ctx =
                        locatePrototypeMember(ts, ls, getProtoIndex, fileName, position) ??
                        locateExpandoMember(ts, ls, getExpandoIndex, fileName, position);
                    return ctx ? buildCallHierarchyItem(ts, ctx) : undefined;
                }, ls.prepareCallHierarchy(fileName, position));

            proxy.provideCallHierarchyIncomingCalls = (fileName, position) =>
                guard("provideCallHierarchyIncomingCalls", () => {
                    const original = ls.provideCallHierarchyIncomingCalls(fileName, position);
                    if (original.length > 0) return original;

                    const protoCtx = locatePrototypeMember(
                        ts, ls, getProtoIndex, fileName, position
                    );
                    if (protoCtx) {
                        const dot = protoCtx.fullName.lastIndexOf(".");
                        return collectPrototypeIncomingCalls(
                            ts,
                            ls,
                            getExtendIndex,
                            getProtoIndex,
                            getExpandoIndex,
                            getIdentifierIndex,
                            protoCtx.fullName.substring(0, dot),
                            protoCtx.fullName.substring(dot + 1)
                        );
                    }

                    const expandoCtx = locateExpandoMember(
                        ts, ls, getExpandoIndex, fileName, position
                    );
                    return expandoCtx
                        ? collectExpandoIncomingCalls(ts, ls, expandoCtx.fullName)
                        : original;
                }, ls.provideCallHierarchyIncomingCalls(fileName, position));
        }

        proxy.getCompletionsAtPosition = (fileName, position, options, formatOptions) =>
            guard("getCompletionsAtPosition", () => {
                const original = ls.getCompletionsAtPosition(fileName, position, options, formatOptions);
                const extras = collectMemberCompletions(
                    ts, ls, getExtendIndex, getExpandoIndex, getProtoIndex, getIdentifierIndex, fileName, position
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

        return proxy;
    }

    return { create };
}

export = init;
