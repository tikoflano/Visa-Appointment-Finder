import http from "http";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { requestIsHttps } from "./httpSecurity";
import type { AdminPasskeyCredential } from "./Store";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = "Visa Appointment Finder";

type ChallengeKind = "registration" | "authentication";

interface PendingChallenge {
  kind: ChallengeKind;
  challenge: string;
  expires: number;
}

const pendingChallenges = new Map<string, PendingChallenge>();

export interface WebAuthnConfig {
  rpID: string;
  rpName: string;
  origin: string;
}

export class WebAuthnError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function pruneChallenges(now = Date.now()): void {
  for (const [key, entry] of pendingChallenges) {
    if (entry.expires < now) pendingChallenges.delete(key);
  }
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function hostnameOnly(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  const idx = host.lastIndexOf(":");
  if (idx > 0 && host.indexOf(":") === idx) return host.slice(0, idx);
  return host;
}

function requestHost(req: http.IncomingMessage): string {
  return String(req.headers.host || "").trim().toLowerCase();
}

export function webAuthnSecureContextOk(req: http.IncomingMessage): boolean {
  if (requestIsHttps(req)) return true;
  const host = hostnameOnly(requestHost(req));
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function getWebAuthnConfig(req: http.IncomingMessage): WebAuthnConfig {
  if (!webAuthnSecureContextOk(req)) {
    throw new WebAuthnError(400, "Passkeys require HTTPS or localhost");
  }

  const publicBase = String(process.env.PUBLIC_BASE_URL || "").trim();
  const publicHost = publicBase ? hostFromUrl(publicBase) : null;
  const reqHost = requestHost(req);
  if (!reqHost && !publicHost) {
    throw new WebAuthnError(400, "Missing Host header for passkey challenge");
  }

  const hostWithPort = (publicHost || reqHost).toLowerCase();
  const rpID = hostnameOnly(hostWithPort);
  if (!rpID) {
    throw new WebAuthnError(400, "Could not determine passkey RP ID");
  }

  let origin: string;
  if (publicBase) {
    try {
      origin = new URL(publicBase).origin;
    } catch {
      throw new WebAuthnError(400, "Invalid PUBLIC_BASE_URL");
    }
  } else {
    const scheme = requestIsHttps(req) ? "https" : "http";
    origin = `${scheme}://${reqHost}`;
  }

  return { rpID, rpName: RP_NAME, origin };
}

function storeChallenge(
  key: string,
  kind: ChallengeKind,
  challenge: string,
): void {
  pruneChallenges();
  pendingChallenges.set(key, {
    kind,
    challenge,
    expires: Date.now() + CHALLENGE_TTL_MS,
  });
}

function takeChallenge(key: string, kind: ChallengeKind): string {
  pruneChallenges();
  const entry = pendingChallenges.get(key);
  pendingChallenges.delete(key);
  if (!entry || entry.kind !== kind || entry.expires < Date.now()) {
    throw new WebAuthnError(400, "Passkey challenge expired; try again");
  }
  return entry.challenge;
}

function toTransports(
  transports: string[] | null | undefined,
): AuthenticatorTransport[] | undefined {
  if (!transports?.length) return undefined;
  return transports as AuthenticatorTransport[];
}

export async function beginAdminPasskeyRegistration(options: {
  req: http.IncomingMessage;
  challengeKey: string;
  existing: Array<{ credentialId: string; transports: string[] | null }>;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const config = getWebAuthnConfig(options.req);
  const registrationOptions = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: "admin",
    userDisplayName: "Admin",
    userID: Buffer.from("visa-admin", "utf8"),
    attestationType: "none",
    excludeCredentials: options.existing.map((item) => ({
      id: item.credentialId,
      transports: toTransports(item.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  storeChallenge(
    options.challengeKey,
    "registration",
    registrationOptions.challenge,
  );
  return registrationOptions;
}

export async function finishAdminPasskeyRegistration(options: {
  req: http.IncomingMessage;
  challengeKey: string;
  response: RegistrationResponseJSON;
}): Promise<{
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[] | null;
}> {
  const config = getWebAuthnConfig(options.req);
  const expectedChallenge = takeChallenge(options.challengeKey, "registration");
  const verification = await verifyRegistrationResponse({
    response: options.response,
    expectedChallenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new WebAuthnError(401, "Passkey registration failed");
  }
  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;
  const responseTransports = options.response.response.transports;
  return {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    transports: responseTransports?.length
      ? [...responseTransports]
      : credential.transports?.length
        ? [...credential.transports]
        : null,
  };
}

export async function beginAdminPasskeyAuthentication(options: {
  req: http.IncomingMessage;
  challengeKey: string;
  allowCredentials: Array<{ credentialId: string; transports: string[] | null }>;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const config = getWebAuthnConfig(options.req);
  if (!options.allowCredentials.length) {
    throw new WebAuthnError(400, "No passkeys registered");
  }
  const authOptions = await generateAuthenticationOptions({
    rpID: config.rpID,
    allowCredentials: options.allowCredentials.map((item) => ({
      id: item.credentialId,
      transports: toTransports(item.transports),
    })),
    userVerification: "preferred",
  });
  storeChallenge(options.challengeKey, "authentication", authOptions.challenge);
  return authOptions;
}

export async function finishAdminPasskeyAuthentication(options: {
  req: http.IncomingMessage;
  challengeKey: string;
  response: AuthenticationResponseJSON;
  credential: AdminPasskeyCredential;
}): Promise<{ newCounter: number }> {
  const config = getWebAuthnConfig(options.req);
  const expectedChallenge = takeChallenge(
    options.challengeKey,
    "authentication",
  );
  const verification = await verifyAuthenticationResponse({
    response: options.response,
    expectedChallenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    credential: {
      id: options.credential.credentialId,
      publicKey: new Uint8Array(options.credential.publicKey),
      counter: options.credential.counter,
      transports: toTransports(options.credential.transports),
    },
    requireUserVerification: false,
  });
  if (!verification.verified) {
    throw new WebAuthnError(401, "Passkey verification failed");
  }
  return { newCounter: verification.authenticationInfo.newCounter };
}
