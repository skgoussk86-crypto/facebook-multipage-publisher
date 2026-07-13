import type { NextConfig } from "next";

const devOrigins = process.env.ALLOWED_DEV_ORIGINS 
  ? process.env.ALLOWED_DEV_ORIGINS.split(",") 
  : [];

const nextConfig: NextConfig = {
  // Only include allowedDevOrigins in non-production environments if defined
  ...(process.env.NODE_ENV !== "production" && devOrigins.length > 0
    ? { allowedDevOrigins: devOrigins }
    : {}),
};

export default nextConfig;