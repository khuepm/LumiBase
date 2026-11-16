/** @type {import('next').NextConfig} */
const studioOrigin = process.env.NEXT_PUBLIC_LUMIBASE_STUDIO_ORIGIN;

const nextConfig = {
  reactStrictMode: true,
  // Live preview (epic #667): allow ONLY the LumiBase Studio to frame this
  // site. Without a Studio origin configured nothing may frame it.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors 'self'${studioOrigin ? ` ${studioOrigin}` : ''}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
