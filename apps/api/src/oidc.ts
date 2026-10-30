import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OidcOptions {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  algorithms?: string[];
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  claims: JWTPayload;
}

/** Remote JWKS is fetched/cached by jose; issuer, audience, algorithm, exp and nbf are enforced. */
export class OidcVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly algorithms: string[];

  constructor(options: OidcOptions) {
    const issuer = new URL(options.issuer);
    const jwks = new URL(options.jwksUrl ?? `${options.issuer.replace(/\/$/, "")}/.well-known/jwks.json`);
    const loopback = (url: URL): boolean => url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (issuer.protocol !== "https:" || (jwks.protocol !== "https:" && !(jwks.protocol === "http:" && loopback(jwks)))) throw new Error("OIDC issuer and JWKS URL must use HTTPS (HTTP is permitted only for loopback JWKS test servers).");
    if (options.audience.trim() === "") throw new Error("OIDC audience must not be empty.");
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.algorithms = options.algorithms ?? ["RS256", "ES256"];
    this.keys = createRemoteJWKSet(jwks, { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 300_000 });
  }

  async verify(token: string): Promise<OidcIdentity> {
    const { payload } = await jwtVerify(token, this.keys, { issuer: this.issuer, audience: this.audience, algorithms: this.algorithms });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("OIDC identity is missing a subject.");
    return { issuer: this.issuer, subject: payload.sub, claims: payload };
  }
}
