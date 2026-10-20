import { Router } from 'express';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { dashboard } from '../trips/trip.service';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);
dashboardRouter.get('/summary', asyncHandler(async (req, res) => {
  res.json(await dashboard(req.user!));
}));
