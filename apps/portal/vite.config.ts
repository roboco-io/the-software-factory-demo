import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // The CSP allows no data: URLs, so nothing may be inlined into the scripts or styles.
    assetsInlineLimit: 0,
  },
});
