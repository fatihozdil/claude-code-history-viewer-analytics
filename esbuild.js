// Bundles the extension with esbuild and copies the sql.js WASM asset.
// UI/runtime assets ship inside the .vsix; history parsing remains local.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Copy the sql.js wasm binary next to the bundle so it can be loaded offline. */
function copyWasm() {
  const src = require.resolve("sql.js/dist/sql-wasm.wasm");
  const destDir = path.join(__dirname, "dist");
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, "sql-wasm.wasm"));
}

/** Ensure media output directory exists. */
function ensureMediaDir() {
  fs.mkdirSync(path.join(__dirname, "media"), { recursive: true });
}

/** Copy the VS Code codicon font + stylesheet into media/ so the webview can render icons offline. */
function copyCodicons() {
  const dist = path.dirname(require.resolve("@vscode/codicons/package.json"));
  const destDir = path.join(__dirname, "media");
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(path.join(dist, "dist", "codicon.css"), path.join(destDir, "codicon.css"));
  fs.copyFileSync(path.join(dist, "dist", "codicon.ttf"), path.join(destDir, "codicon.ttf"));
}

async function main() {
  copyWasm();
  ensureMediaDir();
  copyCodicons();

  // --- Extension host bundle (Node.js / CommonJS) ---
  const extCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode", "sql.js/dist/sql-wasm.wasm"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
    loader: { ".wasm": "file" },
  });

  // --- Webview UI bundle (browser / IIFE) ---
  const uiCtx = await esbuild.context({
    entryPoints: ["src/webview/ui/index.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    outfile: "media/browser.js",
    sourcemap: !production,
    minify: production,
    logLevel: "info",
    jsx: "automatic",
    jsxImportSource: "preact",
    alias: {
      "react": "preact/compat",
      "react-dom": "preact/compat",
    },
    // The webview has no node_modules at runtime — bundle everything.
    external: [],
  });

  if (watch) {
    await Promise.all([extCtx.watch(), uiCtx.watch()]);
  } else {
    await Promise.all([extCtx.rebuild(), uiCtx.rebuild()]);
    await extCtx.dispose();
    await uiCtx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
