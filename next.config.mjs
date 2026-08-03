/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async headers() {
    // Belt-and-suspenders on top of `export const dynamic = 'force-dynamic'`
    // in app/layout.tsx: explicitly tell any CDN/proxy in front of this
    // deployment (Render's Cloudflare, Vercel's edge network, a corporate
    // proxy, the browser itself) never to cache page HTML. This app is an
    // authenticated dashboard where every page depends on runtime session
    // state - there is no page where a year-old cached response is ever
    // correct.
    // _next/static/* is content-hashed and safe (and important) to cache
    // forever - only the actual page/document responses need no-store.
    return [
      {
        source: '/((?!_next/static|_next/image).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, must-revalidate',
          },
        ],
      },
      {
        // The phone capture page (app/capture/[token]) is the only route
        // that needs camera/microphone/motion - explicitly scope those
        // permissions to it rather than leaving them ungoverned app-wide.
        // Nothing previously allowed or blocked these at the header level.
        source: '/capture/:token*',
        headers: [
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), accelerometer=(self), gyroscope=(self)',
          },
        ],
      },
    ]
  },
}

export default nextConfig
