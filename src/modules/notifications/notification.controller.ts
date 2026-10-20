import { Router } from 'express';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { listNotifications } from './notification.service';

export const notificationRouter = Router();
notificationRouter.use(authenticate);
notificationRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ items: await listNotifications(req.user!.id) });
}));
