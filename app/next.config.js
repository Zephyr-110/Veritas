/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@coral-xyz/anchor",
  ],
  webpack: (config, { webpack }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      os: false,
      path: false,
      crypto: false,
      stream: false,
    };
    const extras = ["pino-pretty", "lokijs", "encoding"];
    if (Array.isArray(config.externals)) config.externals.push(...extras);
    else if (config.externals) config.externals = [config.externals, ...extras];
    else config.externals = extras;
    config.plugins.push(
      new webpack.ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
      })
    );
    return config;
  },
};

module.exports = nextConfig;
