/** @type {import('next').NextConfig} */
const config = {
  devIndicators: false, // no dev badge on the projector
  // REST goes through Next so the phone (HTTPS tunnel to :3000) reaches the API on the same origin.
  async rewrites() {
    const api = process.env.PRISM_API ?? 'http://localhost:7100';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};
export default config;
