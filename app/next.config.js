const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ["better-sqlite3"],
  transpilePackages: [
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@coral-xyz/anchor",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "base-uri 'self'",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "media-src 'self' blob: https:",
              "style-src 'self' 'unsafe-inline'",
              "script-src 'self' 'unsafe-inline'",
              "connect-src 'self' https: wss:",
            ].join("; "),
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/chart/:path*",
        destination: "https://api.exchange.coinbase.com/:path*",
      },
    ];
  },
  webpack: (config, { webpack }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      os: false,
      path: false,
      crypto: false,
      stream: false,
      net: false,
      tls: false,
    };
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "jito-ts": path.join(__dirname, "src/stubs/empty.js"),
    };
    const extras = ["pino-pretty", "lokijs", "encoding", "jito-ts"];
    if (Array.isArray(config.externals)) config.externals.push(...extras);
    else if (config.externals) config.externals = [config.externals, ...extras];
    else config.externals = extras;
    config.plugins.push(
      new webpack.ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
      }),
      new webpack.IgnorePlugin({ resourceRegExp: /^jito-ts($|\/)/ })
    );
    return config;
  },
};

module.exports = nextConfig;
