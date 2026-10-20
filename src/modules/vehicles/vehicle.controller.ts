import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { objectIdSchema } from '../../common/validation/primitives';
import { COMMAND_TYPES, createDevice, createVehicle, getVehicle, issueCommand, listDevices, listVehicles, removeVehicle, rotateDeviceKey, updateVehicle, vehicleStatus, vehicleTelemetry } from './vehicle.service';

const vehicleSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  registrationIdentifier: z.string().trim().min(2).max(32),
  assignedDriverId: objectIdSchema.nullable().optional(),
  demo: z.boolean().optional(),
});

const updateSchema = vehicleSchema.partial().extend({
  status: z.enum(['active', 'inactive', 'maintenance']).optional(),
});

const deviceSchema = z.object({
  deviceType: z.enum(['vehicle_unit', 'driver_camera', 'cabin_camera', 'display', 'combined']),
  deviceIdentity: z.string().trim().min(2).max(120),
  firmwareVersion: z.string().max(64).optional(),
  mqttUsername: z.string().trim().min(2).max(120).optional(),
  demo: z.boolean().optional(),
});

const commandSchema = z.object({
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.unknown()).default({}),
}).superRefine((value, ctx) => {
  if (value.type === 'display_text' && typeof value.payload.text !== 'string') {
    ctx.addIssue({ code: 'custom', message: 'payload.text is required', path: ['payload', 'text'] });
  }
  if (value.type === 'display_text' && typeof value.payload.text === 'string' && value.payload.text.length > 120) {
    ctx.addIssue({ code: 'custom', message: 'payload.text is too long', path: ['payload', 'text'] });
  }
  if (value.type === 'set_brightness') {
    const percent = value.payload.percent;
    if (typeof percent !== 'number' || percent < 0 || percent > 100) {
      ctx.addIssue({ code: 'custom', message: 'payload.percent must be 0-100', path: ['payload', 'percent'] });
    }
  }
  if (value.type === 'acknowledge_alarm' && typeof value.payload.eventId !== 'string') {
    ctx.addIssue({ code: 'custom', message: 'payload.eventId is required', path: ['payload', 'eventId'] });
  }
});

export const vehicleRouter = Router();
vehicleRouter.use(authenticate);

vehicleRouter.post('/', asyncHandler(async (req, res) => {
  res.status(201).json(await createVehicle(req.user!, vehicleSchema.parse(req.body)));
}));

vehicleRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await listVehicles(req.user!));
}));

vehicleRouter.get('/:vehicleId', asyncHandler(async (req, res) => {
  res.json(await getVehicle(req.user!, String(req.params.vehicleId)));
}));

vehicleRouter.patch('/:vehicleId', asyncHandler(async (req, res) => {
  res.json(await updateVehicle(req.user!, String(req.params.vehicleId), updateSchema.parse(req.body)));
}));

vehicleRouter.delete('/:vehicleId', asyncHandler(async (req, res) => {
  await removeVehicle(req.user!, String(req.params.vehicleId));
  res.status(204).send();
}));

vehicleRouter.get('/:vehicleId/status', asyncHandler(async (req, res) => {
  res.json(await vehicleStatus(req.user!, String(req.params.vehicleId)));
}));

vehicleRouter.get('/:vehicleId/telemetry', asyncHandler(async (req, res) => {
  res.json(await vehicleTelemetry(req.user!, String(req.params.vehicleId)));
}));

vehicleRouter.post('/:vehicleId/devices', asyncHandler(async (req, res) => {
  res.status(201).json(await createDevice(req.user!, String(req.params.vehicleId), deviceSchema.parse(req.body)));
}));

vehicleRouter.get('/:vehicleId/devices', asyncHandler(async (req, res) => {
  res.json(await listDevices(req.user!, String(req.params.vehicleId)));
}));

vehicleRouter.post('/:vehicleId/devices/:deviceId/rotate-key', asyncHandler(async (req, res) => {
  res.json(await rotateDeviceKey(req.user!, String(req.params.vehicleId), String(req.params.deviceId)));
}));

vehicleRouter.post('/:vehicleId/commands', asyncHandler(async (req, res) => {
  const body = commandSchema.parse(req.body);
  res.status(202).json(await issueCommand(req.user!, String(req.params.vehicleId), body));
}));
