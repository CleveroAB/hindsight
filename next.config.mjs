/** @type {import('next').NextConfig} */

// Next serves only the React UI. Every piece of server state — sessions, live
// runs, SSE, the share page, signal scheduling — lives in the Bun API server
// (server/index.ts), which the phone app uses too. These rewrites forward the
// browser's `/api/*` and `/share/*` requests to it; `proxy.ts` (the front-door
// gate) still runs first, and the rewrite passes the visitor's forwarding
// headers along so the API server can apply the same gate itself.
const API_URL = (process.env.HINDSIGHT_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_URL}/api/:path*` },
      { source: '/share/:path*', destination: `${API_URL}/share/:path*` },
    ];
  },
};

export default nextConfig;
