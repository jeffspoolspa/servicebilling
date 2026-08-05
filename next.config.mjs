/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  // The PDF renderer's browser binary must load from node_modules at
  // runtime, not get bundled — bundling breaks its brotli-packed chromium.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  turbopack: {
    root: import.meta.dirname,
  },
}

export default nextConfig
