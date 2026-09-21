/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js requires inline/eval for its runtime in dev; styles inline for Tailwind.
              "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""),
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https://platform-lookaside.fbsbx.com https://*.fbcdn.net",
              "media-src 'self' blob:",
              "font-src 'self' data:",
              "connect-src 'self' https://graph.facebook.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self' https://www.facebook.com",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
