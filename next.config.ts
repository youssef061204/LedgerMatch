import type { NextConfig } from 'next';
const config: NextConfig = { serverExternalPackages: ['pg', 'pg-boss'], poweredByHeader: false };
export default config;
