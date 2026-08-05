/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  // The PDF renderer's browser binary must load from node_modules at
  // runtime, not get bundled — bundling breaks its brotli-packed chromium.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // The chromium binary is brotli files loaded at runtime — static tracing
  // can't see them, so the generate route must name them explicitly.
  outputFileTracingIncludes: {
    "/api/billing/months/[monthId]/explainer-generate": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  turbopack: {
    root: import.meta.dirname,
  },
}

export default nextConfig
