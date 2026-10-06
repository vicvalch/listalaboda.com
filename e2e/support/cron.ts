/**
 * LB-17: a FAKE, test-only scheduler secret for the E2E app (its text says
 * so). It protects nothing and is never a deployment value; production
 * scheduling is not activated by this repository.
 */
export const E2E_CRON_SECRET = "TEST-ONLY-e2e-cron-secret-not-a-real-value-000";
