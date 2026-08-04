import dotenv from "dotenv";

dotenv.config();

type AppConfig = {
  port: number;
  logLevel: string;
  websocketUser: string;
  websocketAuthToken: string;
  websocketUrl: string;
  websocketModelName: string;
  websocketAgentName: string;
  websocketConnectTimeoutMs: number;
  websocketMessageTimeoutMs: number;
  websocketSessionTtlMs: number;
  healthEndpointPath: string;
  jwtOnlyAuthEnabled: boolean;
  jwtAuthRequiredPathPrefix: string;
  jwtAuthHeader: string;
  openIdConfigurationUrl: string;
  jwtTenantId: string;
  jwtExpectedAudience: string;
  jwtTokenVersion: string;
  jwtAllowedIssuers: string[];
  jwksCacheTtlSeconds: number;
  jwtClockSkewSeconds: number;
  outgoingActivityLogEnabled: boolean;
  streamingResponsesEnabled: boolean;
  verboseSessionUpdates: boolean;
};

function mustGet(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function asNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

function asBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function asCsv(name: string): string[] {
  const raw = process.env[name] ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function defaultIssuers(tenantId: string, tokenVersion: string): string[] {
  if (!tenantId) {
    return [];
  }

  if (tokenVersion === "v2.0") {
    return [
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
      `https://sts.windows.net/${tenantId}/`
    ];
  }

  return [
    `https://sts.windows.net/${tenantId}/`
  ];
}

const openIdConfigurationUrl = (process.env.OPENID_CONFIGURATION_URL ?? "").trim();
const jwtTenantId = process.env.JWT_TENANT_ID ?? process.env.AZURE_TENANT_ID ?? "";
const jwtExpectedAudience = process.env.JWT_EXPECTED_AUDIENCE ?? process.env.AZURE_EXPECTED_AUDIENCE ?? "";
const jwtTokenVersion = process.env.JWT_TOKEN_VERSION ?? process.env.AZURE_TOKEN_VERSION ?? "v2.0";
const explicitAllowedIssuers = asCsv("JWT_ALLOWED_ISSUERS");
const jwtAllowedIssuers = explicitAllowedIssuers.length > 0
  ? explicitAllowedIssuers
  : defaultIssuers(jwtTenantId, jwtTokenVersion);

const jwtOnlyAuthEnabled = asBoolean("JWT_ONLY_AUTH_ENABLED", false);
if (jwtOnlyAuthEnabled) {
  if (!openIdConfigurationUrl && !jwtTenantId) {
    throw new Error("JWT-only auth is enabled but neither OPENID_CONFIGURATION_URL nor JWT_TENANT_ID is configured");
  }
  if (!jwtExpectedAudience) {
    throw new Error("JWT-only auth is enabled but JWT_EXPECTED_AUDIENCE is missing");
  }
  if (jwtAllowedIssuers.length === 0) {
    throw new Error("JWT-only auth is enabled but JWT_ALLOWED_ISSUERS (or derived issuer) is empty");
  }
}

export const config: AppConfig = {
  port: asNumber("PORT", 3978),
  logLevel: process.env.LOG_LEVEL ?? "info",
  websocketUser: process.env.WEBSOCKET_USER ?? "token",
  websocketAuthToken: mustGet("WEBSOCKET_AUTH_TOKEN"),
  websocketUrl: mustGet("WEBSOCKET_URL"),
  websocketModelName: (process.env.WEBSOCKET_MODEL_NAME ?? "").trim(),
  websocketAgentName: (process.env.WEBSOCKET_AGENT_NAME ?? "").trim(),
  websocketConnectTimeoutMs: asNumber("WEBSOCKET_CONNECT_TIMEOUT_MS", 10_000),
  websocketMessageTimeoutMs: asNumber("WEBSOCKET_MESSAGE_TIMEOUT_MS", 30_000),
  websocketSessionTtlMs: asNumber("WEBSOCKET_SESSION_TTL_MS", 14_400_000),
  healthEndpointPath: process.env.HEALTH_ENDPOINT_PATH ?? "/healthz",
  jwtOnlyAuthEnabled,
  jwtAuthRequiredPathPrefix: process.env.JWT_AUTH_REQUIRED_PATH_PREFIX ?? "/api/messages",
  jwtAuthHeader: process.env.JWT_AUTH_HEADER ?? "Authorization",
  openIdConfigurationUrl,
  jwtTenantId,
  jwtExpectedAudience,
  jwtTokenVersion,
  jwtAllowedIssuers,
  jwksCacheTtlSeconds: asNumber("JWKS_CACHE_TTL_SECONDS", 3600),
  jwtClockSkewSeconds: asNumber("JWT_CLOCK_SKEW_SECONDS", 300),
  outgoingActivityLogEnabled: asBoolean("OUTGOING_ACTIVITY_LOG_ENABLED", true),
  streamingResponsesEnabled: asBoolean("STREAMING_RESPONSES_ENABLED", false),
  verboseSessionUpdates: asBoolean("VERBOSE_SESSION_UPDATES", true)
};
