/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    HOSTED_FILES: R2Bucket;
    NODE_ENV: string;
    PORT?: string;
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    BETTER_AUTH_TRUSTED_ORIGINS?: string;
    HOSTED_FILES_BASE_URL: string;
    APPLE_CLIENT_ID?: string;
    APPLE_APP_BUNDLE_IDENTIFIER?: string;
    APPLE_TEAM_ID?: string;
    APPLE_KEY_ID?: string;
    APPLE_PRIVATE_KEY?: string;
    APPLE_CLIENT_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    REVENUECAT_WEBHOOK_SECRET?: string;
    R2_ACCOUNT_ID: string;
    R2_BUCKET: string;
    R2_ENDPOINT?: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}
