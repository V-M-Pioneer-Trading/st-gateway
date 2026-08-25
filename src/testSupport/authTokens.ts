/**
 * @file Test credentials: an ephemeral keypair, generated per test run.
 *
 * Same shape as automation-service's testSupport/authTokens.ts — tests
 * exercise the real verification path in auth.ts, no stub verifier.
 */

import { generateKeyPairSync, sign } from "crypto";

const newKeyPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const { publicKey, privateKey } = newKeyPair();
const foreign = newKeyPair();

/** Pass as auth.clerkJwtKeyPem when constructing an app under test. */
export const TEST_CLERK_JWT_KEY = publicKey;

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

export interface TestTokenOptions {
  sub?: string;
  scopes?: string[];
  expiresInSeconds?: number;
  issuer?: string;
}

function signWith(key: string, options: TestTokenOptions): string {
  const { sub = "user_2TestOperator", scopes = [], expiresInSeconds = 300, issuer } = options;
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    sub,
    scope: scopes.join(" "),
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
    ...(issuer !== undefined ? { iss: issuer } : {}),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** A genuine human Clerk session — the only shape that earns "interactive". */
export const userBearer = (options: TestTokenOptions = {}): string =>
  `Bearer ${signWith(privateKey, { sub: "user_2TestOperator", ...options })}`;

/** A Clerk M2M token's sub is its Machine ID, never "interactive" (decision 19). */
export const machineBearer = (options: TestTokenOptions = {}): string =>
  `Bearer ${signWith(privateKey, { sub: "mch_3TestMachine", ...options })}`;

export const expiredUserBearer = (): string => userBearer({ expiresInSeconds: -60 });

/** Correctly shaped, valid exp — signed by a key st-gateway has never seen. */
export const foreignBearer = (): string => `Bearer ${signWith(foreign.privateKey, { sub: "user_2TestOperator" })}`;
