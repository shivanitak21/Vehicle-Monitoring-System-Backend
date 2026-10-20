import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./src/tests/global-setup.ts'],
    setupFiles: ['./src/tests/setup.ts'],
    fileParallelism: false,
    hookTimeout: 180000,
    testTimeout: 30000,
    globalSetupTimeout: 300000,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
      JWT_ACCESS_TTL_SECONDS: '900',
      JWT_REFRESH_TTL_SECONDS: '2592000',
      CORS_ORIGINS: 'http://localhost:8081',
      MQTT_ENABLED: 'false',
      DEMO_ENABLED: 'false',
      RATE_LIMIT_DISABLED: 'true',
      LOG_LEVEL: 'silent',
      MONGODB_URI: 'mongodb://127.0.0.1:9/placeholder',
      EXPO_PUSH_ACCESS_TOKEN: '',
      S3_BUCKET: '',
      HIGH_RISK_THRESHOLD: '40',
    },
  },
});
