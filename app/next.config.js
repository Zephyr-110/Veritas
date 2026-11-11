const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  transpilePackages: [
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@coral-xyz/anchor",
    "@pythnetwork/hermes-client",
    "@pythnetwork/pyth-solana-receiver",
    "@pythnetwork/solana-utils",
  ],
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
