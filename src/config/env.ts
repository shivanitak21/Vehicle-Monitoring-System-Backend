import { z } from 'zod';

const UNSAFE_SECRETS = new Set([
  'dev-only-access-secret-change-me-32b',
  'dev-backend-mqtt-password',
  'dev-device-mqtt-password',
  'dev-device-ingest-key-change-me',
  'DevOnly-ChangeMe-12345',
]);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.string().min(1).default('info'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  JWT_ISSUER: z.string().min(1).default('vehicle-safety'),
  CORS_ORIGINS: z.string().min(1).default('http://localhost:8081,http://localhost:19006'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  BODY_LIMIT: z.string().min(1).default('256kb'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_DISABLED: z.enum(['true', 'false']).default('false'),
  LOCATION_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(45),
  DEVICE_OFFLINE_AFTER_SECONDS: z.coerce.number().int().positive().default(90),
  LOCATION_MAX_FUTURE_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(30),
  LOCATION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(180),
  LOCATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  HIGH_RISK_THRESHOLD: z.coerce.number().positive().default(40),
  SAFETY_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),
  RISK_RULES_VERSION: z.string().min(1).default('2026.1'),
  MOVING_SPEED_KPH: z.coerce.number().nonnegative().default(3),
  MQTT_ENABLED: z.enum(['true', 'false']).default('true'),
  MQTT_URL: z.string().min(1).default('mqtt://localhost:1883'),
  MQTT_USERNAME: z.string().min(1).default('backend'),
  MQTT_PASSWORD: z.string().default(''),
  MQTT_CLIENT_ID: z.string().min(1).default('vehicle-safety-backend'),
  MQTT_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('true'),
  DEMO_ENABLED: z.enum(['true', 'false']).default('false'),
  DEMO_DEVICE_INGEST_KEY: z.string().default(''),
  EXPO_PUSH_ACCESS_TOKEN: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MEDIA_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),
  VISION_PROVIDER_URL: z.string().default(''),
  VISION_PROVIDER_TOKEN: z.string().default(''),
  VISION_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  SPEECH_PROVIDER_URL: z.string().default(''),
  SEED_GUARDIAN_EMAIL: z.string().default('guardian@example.com'),
  SEED_GUARDIAN_PASSWORD: z.string().default(''),
  SEED_GUARDIAN_NAME: z.string().default('Dev Guardian'),
  SEED_PASSENGER_EMAIL: z.string().default('passenger@example.com'),
  SEED_PASSENGER_PASSWORD: z.string().default(''),
  SEED_PASSENGER_NAME: z.string().default('Dev Passenger'),
  SEED_ADMIN_EMAIL: z.string().default(''),
  SEED_ADMIN_PASSWORD: z.string().default(''),
  SEED_ADMIN_NAME: z.string().default('Dev Administrator'),
});

export type AppConfig = ReturnType<typeof toConfig>;

let cached: AppConfig | undefined;

function toConfig(env: z.infer<typeof envSchema>) {
  const corsOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    isDevelopment: env.NODE_ENV === 'development',
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    mongodbUri: env.MONGODB_URI,
    trustProxy: env.TRUST_PROXY === 'true',
    bodyLimit: env.BODY_LIMIT,
    corsOrigins,
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
      issuer: env.JWT_ISSUER,
    },
    rateLimit: {
      disabled: env.RATE_LIMIT_DISABLED === 'true',
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      authMax: env.AUTH_RATE_LIMIT_MAX,
    },
    location: {
      staleAfterSeconds: env.LOCATION_STALE_AFTER_SECONDS,
      deviceOfflineAfterSeconds: env.DEVICE_OFFLINE_AFTER_SECONDS,
      maxFutureSkewSeconds: env.LOCATION_MAX_FUTURE_SKEW_SECONDS,
      maxAgeSeconds: env.LOCATION_MAX_AGE_SECONDS,
      retentionDays: env.LOCATION_RETENTION_DAYS,
      movingSpeedKph: env.MOVING_SPEED_KPH,
    },
    media: {
      retentionDays: env.MEDIA_RETENTION_DAYS,
      urlTtlSeconds: env.MEDIA_URL_TTL_SECONDS,
      maxBytes: env.MEDIA_UPLOAD_MAX_BYTES,
    },
    safety: {
      highRiskThreshold: env.HIGH_RISK_THRESHOLD,
      windowMinutes: env.SAFETY_WINDOW_MINUTES,
      rulesVersion: env.RISK_RULES_VERSION,
    },
    mqtt: {
      enabled: env.MQTT_ENABLED === 'true',
      url: env.MQTT_URL,
      username: env.MQTT_USERNAME,
      password: env.MQTT_PASSWORD,
      clientId: env.MQTT_CLIENT_ID,
      rejectUnauthorized: env.MQTT_REJECT_UNAUTHORIZED === 'true',
    },
    demo: {
      enabled: env.DEMO_ENABLED === 'true',
      deviceIngestKey: env.DEMO_DEVICE_INGEST_KEY,
    },
    push: {
      expoAccessToken: env.EXPO_PUSH_ACCESS_TOKEN,
      configured: env.EXPO_PUSH_ACCESS_TOKEN.length > 0,
    },
    storage: {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      configured: Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY),
    },
    vision: {
      url: env.VISION_PROVIDER_URL,
      token: env.VISION_PROVIDER_TOKEN,
      timeoutMs: env.VISION_PROVIDER_TIMEOUT_MS,
      configured: env.VISION_PROVIDER_URL.length > 0,
    },
    speech: {
      url: env.SPEECH_PROVIDER_URL,
      configured: env.SPEECH_PROVIDER_URL.length > 0,
    },
    seed: {
      guardianEmail: env.SEED_GUARDIAN_EMAIL,
      guardianPassword: env.SEED_GUARDIAN_PASSWORD,
      guardianName: env.SEED_GUARDIAN_NAME,
      passengerEmail: env.SEED_PASSENGER_EMAIL,
      passengerPassword: env.SEED_PASSENGER_PASSWORD,
      passengerName: env.SEED_PASSENGER_NAME,
      adminEmail: env.SEED_ADMIN_EMAIL,
      adminPassword: env.SEED_ADMIN_PASSWORD,
      adminName: env.SEED_ADMIN_NAME,
    },
  };
}

function assertProductionSafety(config: AppConfig): void {
  if (!config.isProduction) return;
  const problems: string[] = [];
  if (UNSAFE_SECRETS.has(config.jwt.accessSecret)) problems.push('JWT_ACCESS_SECRET uses a development sample');
  if (config.corsOrigins.includes('*')) problems.push('CORS_ORIGINS cannot be * in production');
  if (config.demo.enabled) problems.push('DEMO_ENABLED must be false in production');
  if (config.rateLimit.disabled) problems.push('RATE_LIMIT_DISABLED must be false in production');
  if (config.mqtt.enabled) {
    if (!config.mqtt.url.startsWith('mqtts://')) problems.push('MQTT_URL must use mqtts:// in production');
    if (!config.mqtt.password || config.mqtt.password.length < 12 || UNSAFE_SECRETS.has(config.mqtt.password)) {
      problems.push('MQTT_PASSWORD must be a non-default secret of at least 12 characters');
    }
    if (config.mqtt.username === 'anonymous') problems.push('Anonymous MQTT usernames are not allowed');
  }
  if (UNSAFE_SECRETS.has(config.demo.deviceIngestKey)) problems.push('DEMO_DEVICE_INGEST_KEY uses a development sample');
  if (problems.length > 0) {
    throw new Error(`Refusing to start with unsafe production configuration: ${problems.join('; ')}`);
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const config = toConfig(parsed.data);
  assertProductionSafety(config);
  cached = config;
  return config;
}

export function getConfig(): AppConfig {
  if (!cached) return loadConfig();
  return cached;
}

export function reloadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  cached = undefined;
  return loadConfig(source);
}
