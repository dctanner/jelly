import { privateDevFiles } from "./scripts/dev-files";
import { publicOrigins } from "./src/shared/network";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [privateDevFiles(), react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    cors: false,
    allowedHosts: publicOrigins(process.env.JELLY_PUBLIC_ORIGINS).map(
      (origin) => new URL(origin).hostname,
    ),
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.JELLY_PORT ?? 3100}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: { outDir: "dist" },
});
