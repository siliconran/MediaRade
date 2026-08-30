import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { readFileSync } from 'node:fs';

/* Version and author come from package.json rather than being typed into the
   source. They were hardcoded in two places that drifted independently — the
   boot log and, more seriously, the compliance ledger's `panel` field, which
   is meant to be an evidence record of what produced an entry. A stale version
   there is a wrong audit trail, not just cosmetics. */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/*
 * MediaRade ships inside Adobe CEP, whose panel HTML is loaded over file://
 * by an embedded CEF browser. To be safe there we compile to a single IIFE
 * bundle (no dynamic module loading) with deterministic asset names so the
 * build output can be dropped straight into the extension folder.
 *
 * CEP loads the panel from file://, and Chromium refuses ES module <script>
 * tags over file:// (CORS: origin is "null"). The bundle itself is a plain
 * IIFE, so we re-tag the entry as a classic deferred script after Vite emits
 * it. This is what keeps the panel loadable inside CEF.
 */
function classicScript() {
  return {
    name: 'mediarade-classic-script',
    transformIndexHtml(html) {
      return html.replace(
        /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/,
        '<script defer src="$1"></script>'
      );
    }
  };
}

export default defineConfig({
  plugins: [solid(), classicScript()],
  base: './',
  define: {
    // Stamped into window.MR.builtAt so you can tell at a glance whether the
    // panel is running the bundle you just built (CEF caches aggressively).
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_AUTHOR__: JSON.stringify(pkg.author)
  },
  build: {
    target: 'chrome87',
    outDir: 'dist',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'js/mediarade.js',
        assetFileNames: (info) => {
          const name = info.name || '';
          return name.endsWith('.css') ? 'css/[name][extname]' : 'assets/[name]-[hash][extname]';
        }
      }
    }
  }
});
