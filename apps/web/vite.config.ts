import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const server = process.env.VITE_SERVER_URL ?? process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8787";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "note-extensionless-route",
      configureServer(devServer) {
        devServer.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith("/note?") || req.url === "/note") {
            req.url = req.url.replace(/^\/note/, "/note.html");
          }
          next();
        });
      },
      configurePreviewServer(previewServer) {
        previewServer.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith("/note?") || req.url === "/note") {
            req.url = req.url.replace(/^\/note/, "/note.html");
          }
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        app: resolve(__dirname, "index.html"),
        note: resolve(__dirname, "note.html"),
        stickyNote: resolve(__dirname, "sticky-note.html"),
      },
    },
  },
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
  preview: {
    host: process.env.HOST ?? "127.0.0.1",
  },
});
