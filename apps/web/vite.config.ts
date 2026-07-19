import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // consume shared package from TS source (avoids CJS interop; instant HMR on rule changes)
    alias: { "@stop/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts") },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:2567" },
  },
});
