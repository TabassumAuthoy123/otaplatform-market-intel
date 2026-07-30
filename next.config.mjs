/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Required for the slim Docker image (Dockerfile copies .next/standalone)
  output: 'standalone'
};
export default nextConfig;
