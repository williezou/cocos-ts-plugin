"use strict";

const assert = require("node:assert/strict");
const ts = require("typescript");
const initPlugin = require("../dist/index");

function createLanguageService(source) {
    const fileName = "/virtual/config.js";
    const snapshot = ts.ScriptSnapshot.fromString(source);
    const host = {
        getScriptFileNames: () => [fileName],
        getScriptVersion: () => "0",
        getScriptSnapshot: (name) => (name === fileName ? snapshot : undefined),
        getCurrentDirectory: () => "/virtual",
        getCompilationSettings: () => ({ allowJs: true, checkJs: true, noLib: true }),
        getDefaultLibFileName: () => "lib.d.ts",
        fileExists: (name) => name === fileName,
        readFile: (name) => (name === fileName ? source : undefined),
        readDirectory: () => [],
    };
    const languageService = ts.createLanguageService(host);
    const plugin = initPlugin({ typescript: ts }).create({
        languageService,
        project: { projectService: { logger: { info() {} } } },
    });
    return { fileName, plugin };
}

function assertConfigMemberResolves(source) {
    const { fileName, plugin } = createLanguageService(source);
    const propertyName = "entranceEndingSecs";
    const usageStart = source.lastIndexOf(propertyName);
    assert.notEqual(usageStart, -1);

    const definition = plugin.getDefinitionAndBoundSpan(fileName, usageStart + 1);
    assert.ok(definition && definition.definitions && definition.definitions.length > 0);
    const target = definition.definitions[0].textSpan;
    assert.equal(source.slice(target.start, target.start + target.length), propertyName);

    const quickInfo = plugin.getQuickInfoAtPosition(fileName, usageStart + 1);
    const hover = quickInfo && quickInfo.displayParts
        ? quickInfo.displayParts.map((part) => part.text).join("")
        : "";
    assert.equal(hover, `(property) Midautumn26Config.${propertyName}: 3`);
}

assertConfigMemberResolves(`/** @type {*} */
var Midautumn26Config = {
    entranceEndingSecs: 3,
};
Midautumn26Config.entranceEndingSecs;
`);

assertConfigMemberResolves(`/** @type {*} */
var Midautumn26Config;
Midautumn26Config = {
    entranceEndingSecs: 3,
};
Midautumn26Config.entranceEndingSecs;
`);

// Keep covering the existing direct-expando form while changing object-literal
// indexing, so it cannot silently regress.
assertConfigMemberResolves(`/** @type {*} */
var Midautumn26Config = {};
Midautumn26Config.entranceEndingSecs = 3;
Midautumn26Config.entranceEndingSecs;
`);

// Legacy globals are often guarded so evaluating the file twice preserves an
// existing value. This is the pattern used by sohoojs/configMidautumn26.js.
assertConfigMemberResolves(`
let Midautumn26Config = Midautumn26Config || {
    entranceEndingSecs: 3,
};
Midautumn26Config.entranceEndingSecs;
`);

{
    const source = `
let Midautumn26Config = Midautumn26Config || {
    bundle: {
        bundleNames: {
            poster: "poster_bundle",
        },
    },
};
Midautumn26Config.bundle.bundleNames.poster;
`;
    const { fileName, plugin } = createLanguageService(source);
    const propertyName = "poster";
    const usageStart = source.lastIndexOf(propertyName);
    const definition = plugin.getDefinitionAndBoundSpan(fileName, usageStart + 1);
    assert.ok(definition && definition.definitions && definition.definitions.length > 0);
    const target = definition.definitions[0].textSpan;
    assert.equal(source.slice(target.start, target.start + target.length), propertyName);
}

{
    const source = `
enumSeasonNodeType = {
    pointsRewards: "pointsRewards",
};
enumSeasonNodeType.pointsRewards;
`;
    const { fileName, plugin } = createLanguageService(source);
    const ownerName = "enumSeasonNodeType";
    const usageStart = source.lastIndexOf(ownerName);

    const definition = plugin.getDefinitionAndBoundSpan(fileName, usageStart + 1);
    assert.ok(definition && definition.definitions && definition.definitions.length > 0);
    const target = definition.definitions[0].textSpan;
    assert.equal(source.slice(target.start, target.start + target.length), ownerName);

    const quickInfo = plugin.getQuickInfoAtPosition(fileName, usageStart + 1);
    const hover = quickInfo && quickInfo.displayParts
        ? quickInfo.displayParts.map((part) => part.text).join("")
        : "";
    assert.match(hover, /^\(var\) enumSeasonNodeType:/);
    assert.doesNotMatch(hover, /:\s*any\s*$/);
    assert.match(hover, /pointsRewards/);
}

{
    const source = `
Midautumn26Config = {
    resetMainBtnSpine: function (active) {},
};
Midautumn26Config.resetMainBtnSpine(true);
`;
    const { fileName, plugin } = createLanguageService(source);
    const memberName = "resetMainBtnSpine";
    const declarationStart = source.indexOf(memberName);
    const callStart = source.lastIndexOf(memberName);

    for (const queryStart of [declarationStart, callStart]) {
        const references = plugin.getReferencesAtPosition(fileName, queryStart + 1) ?? [];
        assert.deepEqual(
            references.map((ref) => ref.textSpan.start).sort((a, b) => a - b),
            [declarationStart, callStart]
        );

        const symbols = plugin.findReferences(fileName, queryStart + 1);
        assert.ok(symbols && symbols.length > 0);
        assert.deepEqual(
            symbols[0].references.map((ref) => ref.textSpan.start).sort((a, b) => a - b),
            [declarationStart, callStart]
        );
    }
}

{
    const source = `
let Midautumn26Entrance = function () {};
Midautumn26Entrance.prototype.createBtn = function () {
    this._updateEndingTip();
    let self = this;
    schedule(function () {
        self._updateEndingTip();
    });
};
Midautumn26Entrance.prototype._updateEndingTip = function () {};
`;
    const { fileName, plugin } = createLanguageService(source);
    const memberName = "_updateEndingTip";
    const firstCall = source.indexOf(memberName);
    const secondCall = source.indexOf(memberName, firstCall + memberName.length);
    const declaration = source.lastIndexOf(memberName);
    const expected = [firstCall, secondCall, declaration].sort((a, b) => a - b);

    for (const queryStart of expected) {
        const references = plugin.getReferencesAtPosition(fileName, queryStart + 1) ?? [];
        assert.deepEqual(
            references.map((ref) => ref.textSpan.start).sort((a, b) => a - b),
            expected
        );
        const symbols = plugin.findReferences(fileName, queryStart + 1);
        assert.ok(symbols && symbols.length > 0);
        assert.deepEqual(
            symbols[0].references.map((ref) => ref.textSpan.start).sort((a, b) => a - b),
            expected
        );
    }

    const item = plugin.prepareCallHierarchy(fileName, declaration + 1);
    assert.ok(item && !Array.isArray(item));
    assert.equal(item.name, "_updateEndingTip");
    assert.equal(item.selectionSpan.start, declaration);

    const incoming = plugin.provideCallHierarchyIncomingCalls(fileName, declaration + 1);
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].from.name, "createBtn");
    assert.deepEqual(
        incoming[0].fromSpans.map((span) => span.start).sort((a, b) => a - b),
        [firstCall, secondCall]
    );
}

{
    const source = `
let Midautumn26Entrance = function () {};
Midautumn26Entrance.prototype._onButtonClicked = function () {
    this.showPopup();
};
Midautumn26Entrance.prototype.showPopup = function () {};
Midautumn26Config = {
    showPopup: function () {},
};
function invokeDynamic(handler) {
    handler.handler.showPopup();
    Midautumn26Config.showPopup();
}
`;
    const { fileName, plugin } = createLanguageService(source);
    const declaration = source.indexOf("Midautumn26Entrance.prototype.showPopup") +
        "Midautumn26Entrance.prototype.".length;
    const call = source.indexOf("showPopup");
    const dynamicCall = source.indexOf("handler.handler.showPopup") +
        "handler.handler.".length;
    const configDeclaration = source.indexOf("showPopup: function");
    const configCall = source.indexOf("Midautumn26Config.showPopup") +
        "Midautumn26Config.".length;
    const memberLength = "showPopup".length;
    const expectedReferences = [call, declaration, dynamicCall];

    // VS Code commonly sends the position immediately after the identifier,
    // so cover both the declaration and call-site token boundaries.
    for (const queryPosition of [
        declaration + memberLength,
        call + memberLength,
    ]) {
        const references = plugin.getReferencesAtPosition(fileName, queryPosition) ?? [];
        assert.deepEqual(
            references.map((ref) => ref.textSpan.start).sort((a, b) => a - b),
            expectedReferences
        );

        const symbols = plugin.findReferences(fileName, queryPosition);
        assert.ok(symbols && symbols.length > 0);
        assert.deepEqual(
            symbols[0].references.map((ref) => ref.textSpan.start).sort((a, b) => a - b),
            expectedReferences
        );

        const implementations = plugin.getImplementationAtPosition(fileName, queryPosition) ?? [];
        assert.deepEqual(
            implementations.map((impl) => impl.textSpan.start),
            [declaration]
        );

        const item = plugin.prepareCallHierarchy(fileName, queryPosition);
        assert.ok(item && !Array.isArray(item));
        assert.equal(item.name, "showPopup");
        assert.ok(item.span.start <= item.selectionSpan.start);
        assert.ok(
            item.selectionSpan.start + item.selectionSpan.length <=
            item.span.start + item.span.length
        );
    }

    const incoming = plugin.provideCallHierarchyIncomingCalls(
        fileName, declaration + memberLength
    );
    assert.deepEqual(
        incoming.map((entry) => entry.from.name).sort(),
        ["_onButtonClicked", "invokeDynamic"]
    );
    assert.deepEqual(
        incoming.flatMap((entry) => entry.fromSpans.map((span) => span.start)).sort((a, b) => a - b),
        [call, dynamicCall]
    );
    assert.ok(!expectedReferences.includes(configDeclaration));
    assert.ok(!expectedReferences.includes(configCall));
}

console.log("regression tests passed");
