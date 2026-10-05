/**
 * TEST-ONLY RSVP capability encryption keys (LB-13). Their 32 bytes spell
 * out that they are fake; they protect nothing and must never be used by a
 * deployment. Real keys come from the server environment
 * (`RSVP_CAPABILITY_ENCRYPTION_KEY`) and are never committed.
 */
export const TEST_RSVP_CAPABILITY_KEY = Buffer.from("TEST-ONLY-rsvp-capability-key-00", "utf8");
export const TEST_RSVP_CAPABILITY_KEY_ENV = TEST_RSVP_CAPABILITY_KEY.toString("base64url");

/** A second fake key, for "the server now has a different key" tests. */
export const WRONG_TEST_RSVP_CAPABILITY_KEY = Buffer.from("TEST-ONLY-wrong-capability-key-0", "utf8");

if (TEST_RSVP_CAPABILITY_KEY.length !== 32 || WRONG_TEST_RSVP_CAPABILITY_KEY.length !== 32) {
  throw new Error("test keys must be 32 bytes");
}
