import { decodeProtectedHeader, createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";

type VerifiedRequest = Request & { auth?: JWTPayload };

let jwksResolverPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

function buildOpenIdConfigurationUrl(): string {
  if (config.openIdConfigurationUrl) {
    return config.openIdConfigurationUrl;
  }

  if (config.jwtTokenVersion === "v2.0") {
    return `https://login.microsoftonline.com/${config.jwtTenantId}/v2.0/.well-known/openid-configuration`;
  }
  return `https://login.microsoftonline.com/${config.jwtTenantId}/.well-known/openid-configuration`;
}

async function getJwksResolver(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (jwksResolverPromise) {
    return jwksResolverPromise;
  }

  jwksResolverPromise = (async () => {
    const metadataUrl = buildOpenIdConfigurationUrl();
    const response = await fetch(metadataUrl);

    if (!response.ok) {
      throw new Error(`OpenID configuration fetch failed: HTTP ${response.status}`);
    }

    const metadata = await response.json() as { jwks_uri?: string };
    if (!metadata.jwks_uri) {
      throw new Error("OpenID configuration is missing jwks_uri");
    }

    return createRemoteJWKSet(new URL(metadata.jwks_uri), {
      cacheMaxAge: config.jwksCacheTtlSeconds * 1000
    });
  })();

  return jwksResolverPromise;
}

function sendUnauthorized(res: Response): void {
  res.status(401).json({
    error: "unauthorized",
    message: "Invalid or missing bearer token"
  });
}

function getBearerToken(req: Request): string | null {
  const rawHeader = req.get(config.jwtAuthHeader);
  if (!rawHeader) {
    return null;
  }

  const parts = rawHeader.trim().split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return null;
  }

  return parts[1];
}

function classifyJwtError(error: unknown, token?: string): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.toLowerCase().includes("exp") || message.toLowerCase().includes("expired")) {
    return "expired token";
  }
  if (message.toLowerCase().includes("issuer")) {
    return "wrong issuer";
  }
  if (message.toLowerCase().includes("audience")) {
    return "wrong audience";
  }
  if (message.toLowerCase().includes("alg") || message.toLowerCase().includes("algorithm")) {
    return "invalid algorithm";
  }
  if (message.toLowerCase().includes("no applicable key") || message.toLowerCase().includes("jwks")) {
    if (token) {
      try {
        const header = decodeProtectedHeader(token);
        if (header.kid) {
          return `unknown kid (${header.kid})`;
        }
      } catch {
        return "unknown kid";
      }
    }
    return "unknown kid";
  }
  return "invalid token";
}

export async function jwtAuthMiddleware(req: VerifiedRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "OPTIONS") {
    next();
    return;
  }

  if (!config.jwtOnlyAuthEnabled) {
    next();
    return;
  }

  if (!req.path.startsWith(config.jwtAuthRequiredPathPrefix)) {
    next();
    return;
  }

  const token = getBearerToken(req);
  if (!token) {
    console.warn("[jwt-auth] missing or malformed bearer token", {
      path: req.path,
      method: req.method
    });
    sendUnauthorized(res);
    return;
  }

  try {
    const jwks = await getJwksResolver();
    const result = await jwtVerify(token, jwks, {
      audience: config.jwtExpectedAudience,
      issuer: config.jwtAllowedIssuers,
      algorithms: ["RS256", "RS384", "RS512"],
      clockTolerance: config.jwtClockSkewSeconds
    });

    req.auth = result.payload;
    console.info("[jwt-auth] token validated", {
      path: req.path,
      method: req.method,
      iss: result.payload.iss,
      aud: result.payload.aud,
      sub: result.payload.sub,
      kid: result.protectedHeader.kid
    });
    next();
  } catch (error) {
    console.warn("[jwt-auth] token rejected", {
      path: req.path,
      method: req.method,
      reason: classifyJwtError(error, token)
    });
    sendUnauthorized(res);
  }
}
