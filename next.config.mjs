/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  turbopack: {
    root: import.meta.dirname,
  },
}

export default nextConfig
