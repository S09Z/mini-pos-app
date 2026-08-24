import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt", // never auto-reload mid-transaction — CLAUDE.md rule 6
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "mini-pos-app",
        short_name: "POS",
        description: "Offline-first matcha POS",
        start_url: "/",
        display: "standalone",
        orientation: "landscape",
        background_color: "#F2F3EE",
        theme_color: "#16180F",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
    }),
  ],
});
