import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5183,
    strictPort: true,
    // The frontend calls /api/… on its own origin and this forwards it to the
    // backend, so the browser never makes a cross-origin request and the
    // backend needs no CORS middleware. The rewrite strips the prefix, since
    // the routes are /stats and /drills, not /api/stats.
    //
    // Dev-server only. A production build served from a real host would need a
    // reverse proxy in front of it, or CORS back.
    proxy: {
      "/api": {
        target: "http://localhost:8016",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
