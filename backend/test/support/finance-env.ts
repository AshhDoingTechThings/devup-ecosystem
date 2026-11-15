/**
 * Imported first by finance tests: config/env.ts is read once, at the first
 * import of any server module, so the encryption key for bank details must be
 * in place before then. A throwaway test key — never a real one.
 */
process.env.CREDENTIAL_ENCRYPTION_KEY ||= "ab".repeat(32);
process.env.FINANCE_CRON_SECRET ||= "test-cron-secret-not-real-0123456789";
