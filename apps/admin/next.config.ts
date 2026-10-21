import type { NextConfig } from 'next';
import path from 'path';
import { apiProxyRewrites } from './src/lib/api-proxy';

// The SERVER-side rewrite target, read at run time: one prebuilt image runs
// against any API. `NEXT_PUBLIC_API_URL` stays the escape hatch for a split
// deployment where the browser must call the API cross-origin directly.
const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Without this Next guesses the trace root from the nearest lockfiles and can
  // land ABOVE the repo, which moves `server.js` inside the standalone output.
  // Pin it to the workspace root so the image's CMD path is the same everywhere.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  typescript: {
    // Type-checking is handled by CI / local `tsc --noEmit`.
    // The tRPC types package references @prisma/client.$Enums which
    // requires `prisma generate` — unnecessary for the admin app.
    ignoreBuildErrors: true,
  },
  webpack(config) {
    config.resolve.alias['#trpc'] = path.resolve(__dirname, 'node_modules/#trpc/types.ts');
    // The trpc types package's types.ts ends with `export { linkTrpcWsServer, trpcRouter }`
    // which are declare-only symbols. SWC strips the declarations but keeps the
    // export statement, causing "Export is not defined". Strip that line.
    config.module.rules.push({
      test: /trpc[\\/]types\.ts$/,
      loader: 'string-replace-loader',
      options: {
        search: /^export \{ linkTrpcWsServer, trpcRouter \};$/m.source,
        replace: '',
        flags: 'm',
      },
    });
    return config;
  },
  async headers() {
    // Google Identity Services (the GoogleLogin button) opens a popup that
    // posts the credential back to the opener via window.postMessage. A strict
    // COOP severs that opener link ("Cross-Origin-Opener-Policy policy would
    // block the window.postMessage call"); same-origin-allow-popups keeps it.
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' }],
      },
    ];
  },
  async rewrites() {
    // The path list lives in src/lib/api-proxy.ts, shared with the middleware
    // that re-points these same paths at run time.
    return apiProxyRewrites(apiUrl);
  },
};

export default nextConfig;
