import { getConfig } from '../../config/env';
import { AppError } from '../../common/errors/app-error';

export type CabinReview = {
  modelGenerated: true;
  provider: string;
  summary: string;
  identityInferred: false;
  safetyDetermined: false;
};

export async function reviewCabinStill(input: { imageUrl: string; signal?: AbortSignal }): Promise<CabinReview> {
  const config = getConfig();
  if (!config.vision.configured) {
    throw new AppError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'No vision-language provider is configured. No cabin image was analyzed.',
    );
  }
  const timeout = AbortSignal.timeout(config.vision.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await fetch(config.vision.url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(config.vision.token ? { Authorization: `Bearer ${config.vision.token}` } : {}),
    },
    body: JSON.stringify({
      imageUrl: input.imageUrl,
      instructions: 'Describe observable cabin conditions. Do not identify a person. Do not decide that anyone is safe.',
    }),
  });
  if (!response.ok) {
    throw new AppError(502, 'PROVIDER_FAILED', 'The vision provider returned an error. No review was stored as successful.');
  }
  const body = (await response.json()) as { summary?: string };
  return {
    modelGenerated: true,
    provider: 'configured-http-provider',
    summary: typeof body.summary === 'string' ? body.summary.slice(0, 2000) : 'The provider returned no summary.',
    identityInferred: false,
    safetyDetermined: false,
  };
}

export function speechProviderStatus(): { configured: boolean; performsTranscription: false } {
  return { configured: getConfig().speech.configured, performsTranscription: false };
}

export function driverMonitorStatus(): { performsInference: false; acceptsStructuredEvents: true } {
  return { performsInference: false, acceptsStructuredEvents: true };
}
