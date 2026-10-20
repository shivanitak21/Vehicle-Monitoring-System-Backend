import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { objectIdSchema, paginationQuerySchema } from '../../common/validation/primitives';
import * as tripService from './trip.service';

const placeSchema = z.object({
  label: z.string().trim().min(1).max(200),
  latitude: z.number().gte(-90).lte(90).nullable().optional(),
  longitude: z.number().gte(-180).lte(180).nullable().optional(),
});

const createSchema = z.object({
  passengerId: objectIdSchema,
  vehicleId: objectIdSchema,
  driverId: objectIdSchema.nullable().optional(),
  origin: placeSchema,
  destination: placeSchema,
  authorizedGuardianIds: z.array(objectIdSchema).max(20).optional(),
  sharing: z.object({
    shareLocation: z.boolean().optional(),
    shareMedia: z.boolean().optional(),
  }).optional(),
  demo: z.boolean().optional(),
});

export const tripRouter = Router();
tripRouter.use(authenticate);

tripRouter.post('/', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  res.status(201).json(await tripService.createTrip(req.user!, body));
}));

tripRouter.get('/', asyncHandler(async (req, res) => {
  const query = paginationQuerySchema.extend({
    status: z.enum(['scheduled', 'active', 'completed', 'cancelled', 'interrupted']).optional(),
  }).parse(req.query);
  res.json(await tripService.listTrips(req.user!, query));
}));

tripRouter.get('/:tripId', asyncHandler(async (req, res) => {
  res.json(await tripService.getTrip(req.user!, String(req.params.tripId)));
}));

tripRouter.post('/:tripId/start', asyncHandler(async (req, res) => {
  res.json(await tripService.changeStatus(req.user!, String(req.params.tripId), 'active'));
}));

tripRouter.post('/:tripId/end', asyncHandler(async (req, res) => {
  res.json(await tripService.changeStatus(req.user!, String(req.params.tripId), 'completed'));
}));

tripRouter.post('/:tripId/cancel', asyncHandler(async (req, res) => {
  res.json(await tripService.changeStatus(req.user!, String(req.params.tripId), 'cancelled'));
}));

tripRouter.post('/:tripId/interrupt', asyncHandler(async (req, res) => {
  res.json(await tripService.changeStatus(req.user!, String(req.params.tripId), 'interrupted'));
}));

tripRouter.get('/:tripId/locations', asyncHandler(async (req, res) => {
  const query = paginationQuerySchema.parse(req.query);
  res.json(await tripService.tripLocations(req.user!, String(req.params.tripId), query.cursor, query.limit));
}));

tripRouter.get('/:tripId/events', asyncHandler(async (req, res) => {
  const query = paginationQuerySchema.parse(req.query);
  res.json(await tripService.tripEvents(req.user!, String(req.params.tripId), query.cursor, query.limit));
}));

tripRouter.get('/:tripId/route', asyncHandler(async (req, res) => {
  res.json(await tripService.tripRoute(req.user!, String(req.params.tripId)));
}));
