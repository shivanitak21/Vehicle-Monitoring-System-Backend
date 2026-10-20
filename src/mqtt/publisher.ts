type PublishFn = (topic: string, payload: unknown) => Promise<void>;

let connected = false;
let publishFn: PublishFn | null = null;

export function setMqttPublisher(fn: PublishFn | null, isConnected: boolean): void {
  publishFn = fn;
  connected = isConnected && Boolean(fn);
}

export function isMqttConnected(): boolean {
  return connected;
}

export async function publishMqtt(topic: string, payload: unknown): Promise<void> {
  if (!publishFn || !connected) {
    throw new Error('MQTT broker is not connected');
  }
  await publishFn(topic, payload);
}
