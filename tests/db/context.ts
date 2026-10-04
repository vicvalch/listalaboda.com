// Fake, local-only identities. Nothing here is a real person or credential.
export const TEST_EMAIL_DOMAIN = "example.test";

export const TEST_USERS = {
  ownerA: `owner-a@${TEST_EMAIL_DOMAIN}`,
  collabA: `collab-a@${TEST_EMAIL_DOMAIN}`,
  ownerB: `owner-b@${TEST_EMAIL_DOMAIN}`,
  outsider: `outsider@${TEST_EMAIL_DOMAIN}`,
  invitee: `invitee@${TEST_EMAIL_DOMAIN}`,
} as const;

export type TestUserKey = keyof typeof TEST_USERS;

export type TestUser = {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
};

export type DbTestContext = {
  apiUrl: string;
  dbUrl: string;
  publishableKey: string;
  /**
   * The LOCAL stack's secret (service_role) key. Only for exercising the
   * server-only delivery recorder (ADR-004) and its service_role-only RPC;
   * never used to arrange fixtures or to perform an action under test as a user.
   */
  secretKey: string;
  users: Record<TestUserKey, TestUser>;
};

declare module "vitest" {
  export interface ProvidedContext {
    db: DbTestContext;
  }
}
