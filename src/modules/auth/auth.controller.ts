import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { authRateLimit as limitAuth } from '../../common/middleware/rate-limit';
import { emailSchema, passwordSchema } from '../../common/validation/primitives';
import * as authService from './auth.service';

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(['guardian', 'passenger']),
  phone: z.string().trim().min(7).max(32).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(200),
});

export const authRouter = Router();

authRouter.post(
  '/register',
  limitAuth(),
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const result = await authService.register(body);
    res.status(201).json(result);
  }),
);

authRouter.post(
  '/login',
  limitAuth(),
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const result = await authService.login(body, req.get('user-agent') ?? '');
    res.status(200).json(result);
  }),
);

authRouter.post(
  '/refresh',
  limitAuth(),
  asyncHandler(async (req, res) => {
    const body = refreshSchema.parse(req.body);
    const result = await authService.refresh(body.refreshToken, req.get('user-agent') ?? '');
    res.status(200).json(result);
  }),
);

authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await authService.logout(req.user!.id);
    res.status(204).send();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await authService.me(req.user!.id);
    res.status(200).json(user);
  }),
);

export const profileRouter = Router();

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(32).optional(),
});

const prefsSchema = z.object({
  tripStart: z.boolean().optional(),
  arrival: z.boolean().optional(),
  speeding: z.boolean().optional(),
  fatigue: z.boolean().optional(),
  sos: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'at least one preference is required' });

profileRouter.use(authenticate);

profileRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body);
    res.json(await authService.updateProfile(req.user!.id, body));
  }),
);

profileRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const settings = await authService.getSettings(req.user!.id);
    res.json(settings.notificationPrefs);
  }),
);

profileRouter.patch(
  '/notifications',
  asyncHandler(async (req, res) => {
    const body = prefsSchema.parse(req.body);
    res.json(await authService.updateNotificationPrefs(req.user!.id, body));
  }),
);

