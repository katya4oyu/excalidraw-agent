import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.VITE_SERVER_URL ?? process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/collab": {
        target: server,
        ws: true,
      },
    },
  },
});
