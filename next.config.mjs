/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The run manager keeps live agent processes / SSE subscribers in module state.
  // Keep server external packages out of the bundle where relevant.
  experimental: {
    // Server Actions are not used; we rely on Route Handlers + SSE.
  },
};

export default nextConfig;
