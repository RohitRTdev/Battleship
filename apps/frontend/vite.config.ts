import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  cacheDir: "/tmp/vite-cache",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    hmr: {
      clientPort: Number(process.env.VITE_HMR_CLIENT_PORT ?? 8000)
    }
  }
});
