import { TEST_RESEND_WEBHOOK_SECRET } from "../../src/test/fixtures/resend-webhook";

/**
 * LB-18.2: a FAKE, test-only Resend webhook signing secret for the E2E app
 * (its bytes say so). It protects nothing and is never a deployment value;
 * no production webhook is configured by this repository.
 */
export const E2E_RESEND_WEBHOOK_SECRET = TEST_RESEND_WEBHOOK_SECRET;
