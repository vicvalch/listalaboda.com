import "server-only";

import { getAppOrigin } from "@/lib/http/app-origin";
import {
  getRsvpCapabilityEncryptionSettings,
  type RsvpCapabilityEncryptionSettings,
} from "@/lib/security/rsvp-capability-encryption";

/**
 * What issuing or recovering a guest link needs from the server
 * configuration (LB-13): the trusted origin every absolute RSVP link is
 * built from (`APP_ORIGIN`, never the request's Host/Origin headers) and the
 * key that makes the link recoverable (ADR-006). Needs no email provider.
 */
export type GuestLinkConfig = Readonly<{
  appOrigin: string;
  encryption: RsvpCapabilityEncryptionSettings;
}>;

/** null = not configured (no valid `APP_ORIGIN` or key): callers refuse before any write. */
export function getGuestLinkConfig(): GuestLinkConfig | null {
  const appOrigin = getAppOrigin();
  const encryption = getRsvpCapabilityEncryptionSettings();
  if (!appOrigin || !encryption.ok) return null;
  return { appOrigin, encryption: encryption.settings };
}
