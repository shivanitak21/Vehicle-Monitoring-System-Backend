import 'dotenv/config';
import { sha256 } from '../src/common/utils/crypto';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { loadConfig } from '../src/config/env';
import { DeviceModel } from '../src/models/vehicle';
import { UserModel } from '../src/models/user';
import * as auth from '../src/modules/auth/auth.service';
import * as family from '../src/modules/family/family.service';
import * as trips from '../src/modules/trips/trip.service';
import * as vehicles from '../src/modules/vehicles/vehicle.service';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) throw new Error('Refusing to seed while NODE_ENV=production');
  if (!config.demo.enabled) throw new Error('Set DEMO_ENABLED=true so seeded trips stay marked as demo data');
  if (!config.seed.guardianPassword || !config.seed.passengerPassword) {
    throw new Error('Set SEED_GUARDIAN_PASSWORD and SEED_PASSENGER_PASSWORD');
  }
  await connectDatabase();
  const existing = await UserModel.findOne({ email: config.seed.guardianEmail });
  if (existing) {
    console.log('Seed accounts already exist. No records were changed.');
    await disconnectDatabase();
    return;
  }

  const guardian = await auth.register({
    name: config.seed.guardianName,
    email: config.seed.guardianEmail,
    password: config.seed.guardianPassword,
    role: 'guardian',
  });
  const passenger = await auth.register({
    name: config.seed.passengerName,
    email: config.seed.passengerEmail,
    password: config.seed.passengerPassword,
    role: 'passenger',
    phone: '5550001111',
  });
  const guardianAuth = {
    id: guardian.user.id,
    role: 'guardian' as const,
    email: guardian.user.email,
    name: guardian.user.name,
    familyGroupId: guardian.user.familyGroupId,
  };
  const member = await family.createMember(guardianAuth, {
    name: passenger.user.name,
    relationship: 'child',
    phone: '5550001111',
    role: 'passenger',
    email: passenger.user.email,
  });
  const passengerDoc = await UserModel.findById(passenger.user.id);
  await family.setConsent(
    {
      id: passenger.user.id,
      role: 'passenger',
      email: passenger.user.email,
      name: passenger.user.name,
      familyGroupId: passengerDoc?.familyGroupId ? passengerDoc.familyGroupId.toString() : null,
    },
    member.id,
    { status: 'granted', sharingLocation: true },
  );
  await auth.updatePrivacy(passenger.user.id, { cameraEvidence: true, speechMonitoring: true, shareWithGuardians: true });
  const vehicle = await vehicles.createVehicle(guardianAuth, {
    displayName: 'Demo Van',
    registrationIdentifier: 'DEMO-001',
    demo: true,
  });
  const device = await vehicles.createDevice(guardianAuth, vehicle.id, {
    deviceType: 'combined',
    deviceIdentity: 'demo-device',
    mqttUsername: process.env.MQTT_DEVICE_USERNAME || 'demo-device',
    demo: true,
  });
  if (config.demo.deviceIngestKey) {
    await DeviceModel.updateOne({ _id: device.device.id }, { $set: { ingestKeyHash: sha256(config.demo.deviceIngestKey) } });
  }
  const trip = await trips.createTrip(guardianAuth, {
    passengerId: passenger.user.id,
    vehicleId: vehicle.id,
    origin: { label: 'Demo origin' },
    destination: { label: 'Demo destination' },
    demo: true,
    sharing: { shareLocation: true, shareMedia: true },
  });
  const started = await trips.changeStatus(guardianAuth, trip.id, 'active');
  let adminEmail: string | null = null;
  if (config.seed.adminEmail && config.seed.adminPassword) {
    const admin = await auth.createAdministrator({
      name: config.seed.adminName,
      email: config.seed.adminEmail,
      password: config.seed.adminPassword,
    });
    adminEmail = admin.email;
  }

  console.log(JSON.stringify({
    note: 'Development seed only. Replace every password before production.',
    guardian: config.seed.guardianEmail,
    passenger: config.seed.passengerEmail,
    administrator: adminEmail,
    vehicleId: vehicle.id,
    tripId: started.id,
    deviceIdentity: 'demo-device',
    ingestKeyFromEnv: Boolean(config.demo.deviceIngestKey),
  }, null, 2));
  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
