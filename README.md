# cocos-ts-plugin

A TypeScript Language Service plugin that gives **VS Code / any tsserver-based editor** working Go-to-Definition and hover info for `this.xxx` inside cocos2d-x / cocos2d-html5 `cc.Class.extend({...})` class literals.

## Why

cocos2d-html5 defines classes through a `cc.Class.extend(props)` pattern. A typical class looks like:

```js
let FlyingObject = cc.Node.extend({
    delay: 0,
    sourceNode: null,
    resetFlyStats: function (sourceNode) {
        this.sourceNode = sourceNode;   // ← tsserver shows `any`, can't jump
        this.callHelper();              // ← tsserver shows `any`, can't jump
    },
    callHelper: function () {}
});
```

Out of the box, `tsserver` infers `this` inside the literal as `any` — Go-to-Definition fails and hover only shows `any`. Adding a `.d.ts` with `ThisType<T>` works in isolation, but breaks on real cocos2d-html5 source because of self-referential JSDoc (`@param {cc.Node}` *inside* the literal that defines `cc.Node`) and JS files that re-assign `cc.Node` as a plain object. tsserver gives up and falls back to `any`.

This plugin sidesteps the whole type-inference problem by hooking the Language Service directly: when you query something inside an `X.extend({...})` literal, it walks the AST and resolves `this.<member>` against the literal's own properties.

## Features

- **Go to Definition**: `Cmd/Ctrl-click` on `this.xxx` jumps to `xxx:` in the same literal
- **Hover**: shows `(method) xxx: (n: any) => number` or `(property) xxx: 0` with JSDoc

Both are added only when tsserver's native answer is missing or `any` — normal IntelliSense is untouched.

### Currently MVP-scoped

Resolves `this.xxx` against **the same literal** only. Cross-file parent-class chains (`this.getPosition()` falling through to `cc.Node`'s definition in CCNode.js) are not yet supported.

## Install

```bash
npm install --save-dev cocos-ts-plugin
```

Then in your `jsconfig.json` (or `tsconfig.json`):

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "cocos-ts-plugin" }
    ]
  }
}
```

### VS Code setup

VS Code's bundled TypeScript does not load plugins from `jsconfig.json` automatically. Two ways to enable it:

**Option A — Use the project's TypeScript** (recommended)

```bash
npm install --save-dev typescript
```

Then `Cmd+Shift+P` → `TypeScript: Select TypeScript Version` → pick the workspace version.

**Option B — Whitelist the plugin path globally**

In `.vscode/settings.json`:

```json
{
  "typescript.tsserver.pluginPaths": [
    "./node_modules/cocos-ts-plugin"
  ]
}
```

After either option, `Cmd+Shift+P` → `TypeScript: Restart TS Server`.

## Verify it loaded

`Cmd+Shift+P` → `TypeScript: Open TS Server Log` (you may need to set `"typescript.tsserver.log": "verbose"` first and restart). Grep for `cocos-ts-plugin` — you should see `[cocos-ts-plugin] plugin loaded`.

## How it works

The plugin proxies three Language Service methods:

| Method | Behavior |
|---|---|
| `getDefinitionAndBoundSpan` | If tsserver returns no definitions, parse the source, locate the enclosing `<X>.extend({...})` literal, and return the matching `xxx:` property as the definition. |
| `getDefinitionAtPosition` | Same. |
| `getQuickInfoAtPosition` | If tsserver returns `any` or nothing, build hover info from the property's value (function signature for `function(){}` initializers, inferred type otherwise) and emit its JSDoc. |

The proxy never intercepts when tsserver already has a real answer, so it composes safely with `@types` packages, `ThisType<T>` hints, and any other type augmentation you might add.

## Build from source

```bash
git clone https://github.com/williezou/cocos-ts-plugin.git
cd cocos-ts-plugin
npm install
npm run build
```

Output lands in `dist/`.

## Roadmap

- [ ] Walk parent-class chain across files (`X = cc.Node.extend({...})` → resolve `this.getPosition` to `CCNode.js`)
- [ ] Auto-completion provider (`this.<TAB>` lists literal members)
- [ ] Handle `_super.xxx`
- [ ] Optional configuration: which extend-style method names to detect (`extend`, `create`, …)

## License

MIT
