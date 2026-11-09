import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { build as esbuild } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The manifest is per browser. public/manifest.json holds what every browser
 * takes, config/manifest.targets.json holds what only some of them need.
 *
 * Chrome runs the background as a service worker and docks the wallet in a
 * side panel. Firefox has no service worker, so its background is an event
 * page, and its docked panel is a sidebar. The windows permission is not a
 * permission in either browser, so it is gone.
 */
type ManifestTarget = {
  manifest?: Record<string, unknown>;
  addPermissions?: string[];
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function manifestFor(root: string, target: string): Record<string, unknown> {
  const base = readJson<Record<string, unknown> & { permissions?: string[] }>(
    resolve(root, "public/manifest.json"),
  );
  const targets = readJson<Record<string, ManifestTarget>>(
    resolve(root, "config/manifest.targets.json"),
  );
  const extra = targets[target];
  if (!extra) {
    throw new Error(`unknown build target: ${target}`);
  }
  return {
    ...base,
    ...(extra.manifest ?? {}),
    permissions: [...(base.permissions ?? []), ...(extra.addPermissions ?? [])],
  };
}

/**
 * Write the manifest of the target over the copy Vite made from public/.
 * Vite empties the output and copies public/ into it before it writes the
 * bundle, so a closeBundle hook lands last.
 */
function writeManifest(target: string): Plugin {
  let root = process.cwd();
  let outDir = "build";
  return {
    name: "write-manifest",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    closeBundle() {
      const manifest = manifestFor(root, target);
      writeFileSync(
        resolve(root, outDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}

// The background script needs `webextension-polyfill` in scope, which means it
// has to be bundled rather than copied verbatim from `public/`. Run in
// `closeBundle` so it lands *after* Vite has finished writing (and emptying)
// `build/` — an earlier hook would be wiped.
/**
 * Vite marks scripts and stylesheets crossorigin. Firefox then loads those
 * extension files as CORS requests and rejects them with SecurityError
 * "The operation is insecure." Same-origin extension assets do not need it.
 */
function stripCrossorigin(): Plugin {
  return {
    name: "strip-crossorigin",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/\s+crossorigin(?:="[^"]*")?/g, "");
      },
    },
  };
}

/**
 * warthog-ts (and bip39) call the Node global `Buffer` and do not import it.
 * Assigning `window.Buffer` from the page entry does not define that name
 * inside an ES module, so a send throws "Buffer is not defined".
 * Give each of those modules the polyfill in src/polyfills/buffer.ts.
 * That file is `buffer` 5.7.1 plus `writeBigUInt64BE`, which the package lacks
 * and which warthog-ts uses for fee and amount. Skip files that already
 * bind the name.
 */
function provideBuffer(): Plugin {
  let polyfill = resolve(process.cwd(), "src/polyfills/buffer.ts");
  return {
    name: "provide-buffer",
    enforce: "pre",
    configResolved(config) {
      polyfill = resolve(config.root, "src/polyfills/buffer.ts");
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.(?:[cm]?js|tsx?|jsx)$/.test(file)) return null;
      if (file.includes("/node_modules/buffer/")) return null;
      if (file.endsWith("/src/polyfills/buffer.ts")) return null;
      if (!/\bBuffer\b/.test(code)) return null;
      if (/from\s+["']buffer["']/.test(code)) return null;
      if (/require\(\s*["']buffer["']\s*\)/.test(code)) return null;
      if (/import\s*\{[^}]*\bBuffer\b/.test(code)) return null;
      if (/\b(?:function|class|var|let|const)\s+Buffer\b/.test(code)) return null;
      return {
        code: `import { Buffer } from ${JSON.stringify(polyfill)};\n${code}`,
        map: null,
      };
    },
  };
}

function bundleBackground(): Plugin {
  let root = process.cwd();
  let outDir = "build";
  return {
    name: "bundle-background",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    async closeBundle() {
      await esbuild({
        entryPoints: ["src/background-entry.js"],
        outfile: resolve(root, outDir, "background.js"),
        bundle: true,
        format: "iife",
        target: "chrome110",
        define: { "process.env.NODE_ENV": '"production"' },
        logLevel: "info",
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // The mode names the target. The plain build runs in the production mode,
  // and that is the Chromium one.
  const target = mode === "firefox" ? "firefox" : "chromium";
  const outDir = target === "firefox" ? "build-firefox" : "build";

  return {
    plugins: [
      provideBuffer(),
      react(),
      stripCrossorigin(),
      bundleBackground(),
      viteStaticCopy({
        targets: [
          {
            src: "config/nodes.json",
            dest: ".",
          },
        ],
      }),
      writeManifest(target),
    ],
    worker: {
      // The signing worker is its own bundle. It needs the Buffer polyfill too.
      plugins: () => [provideBuffer()],
    },
    optimizeDeps: {
      include: ["ethers"],
      // warthog-ts is consumed as ESM; pre-bundling it breaks its
      // `type: module` exports.
      exclude: ["warthog-ts"],
    },
    build: {
      outDir,
      rollupOptions: {
        input: {
          main: "./index.html",
        },
      },
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
  };
});
