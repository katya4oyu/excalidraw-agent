import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.VITE_SERVER_URL ?? process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8787";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port,
    strictPort: Boolean(process.env.PORT),
    proxy: {
      "/api": {
        target: server,
        changeOrigin: true,
        secure: false,
      },
      "/collab": {
        target: server,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
});
