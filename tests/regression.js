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

console.log("regression tests passed");
