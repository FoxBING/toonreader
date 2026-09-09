import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Never watch the Rust build tree (locked exes crash the watcher with
      // EBUSY on Windows), the upscale cache, or the bundled waifu2x.
      ignored: ["**/src-tauri/target/**", "**/cache/**", "**/waifu2x/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
