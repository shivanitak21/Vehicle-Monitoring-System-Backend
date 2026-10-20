import mqtt from 'mqtt';
import { getConfig } from '../config/env';
import { logger } from '../config/logger';
import { handleMqttMessage } from './handlers';
import { setMqttPublisher } from './publisher';

let client: mqtt.MqttClient | null = null;

const TOPICS = [
  'vehicles/+/telemetry',
  'vehicles/+/safety',
  'vehicles/+/cabin',
  'vehicles/+/device-status',
  'vehicles/+/sos',
];

export async function startMqtt(): Promise<void> {
  const config = getConfig();
  if (!config.mqtt.enabled) {
    setMqttPublisher(null, false);
    logger.info('mqtt disabled');
    return;
  }
  client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: config.mqtt.clientId,
    reconnectPeriod: 2000,
    clean: false,
    rejectUnauthorized: config.mqtt.rejectUnauthorized,
  });
  client.on('connect', () => {
    logger.info('mqtt connected');
    setMqttPublisher(async (topic, payload) => {
      await new Promise<void>((resolve, reject) => {
        client?.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => (error ? reject(error) : resolve()));
      });
    }, true);
    for (const topic of TOPICS) {
      client?.subscribe(topic, { qos: 1 }, (error) => {
        if (error) logger.error({ err: error, topic }, 'mqtt subscribe failed');
      });
    }
  });
  client.on('reconnect', () => logger.warn('mqtt reconnecting'));
  client.on('close', () => setMqttPublisher(null, false));
  client.on('error', (error) => logger.error({ err: error }, 'mqtt client error'));
  client.on('message', (topic, payload) => {
    void handleMqttMessage(topic, payload);
  });
}

export async function stopMqtt(): Promise<void> {
  setMqttPublisher(null, false);
  if (!client) return;
  await new Promise<void>((resolve) => {
    client?.end(false, {}, () => resolve());
  });
  client = null;
}
