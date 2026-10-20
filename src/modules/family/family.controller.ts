import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { emailSchema } from '../../common/validation/primitives';
import * as familyService from './family.service';

const memberSchema = z.object({
  name: z.string().trim().min(2).max(120),
  relationship: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(7).max(32),
  role: z.enum(['guardian', 'passenger', 'driver']),
  email: emailSchema.optional(),
});

const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  relationship: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(7).max(32),
});

const consentSchema = z.object({
  status: z.enum(['granted', 'revoked']),
  sharingLocation: z.boolean().optional(),
});

const privacySchema = z
  .object({
    shareWithGuardians: z.boolean().optional(),
    foregroundSharing: z.boolean().optional(),
    backgroundSharing: z.boolean().optional(),
    cameraEvidence: z.boolean().optional(),
    speechMonitoring: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one privacy setting is required' });

export const familyRouter = Router();
familyRouter.use(authenticate);

familyRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await familyService.getFamily(req.user!));
}));

familyRouter.get('/passengers', asyncHandler(async (req, res) => {
  res.json(await familyService.listPassengers(req.user!));
}));

familyRouter.get('/members', asyncHandler(async (req, res) => {
  res.json(await familyService.listMembers(req.user!));
}));

familyRouter.post('/members', asyncHandler(async (req, res) => {
  const body = memberSchema.parse(req.body);
  res.status(201).json(await familyService.createMember(req.user!, body));
}));

familyRouter.delete('/members/:memberId', asyncHandler(async (req, res) => {
  await familyService.removeMember(req.user!, String(req.params.memberId));
  res.status(204).send();
}));

familyRouter.post('/relationships/:relationshipId/consent', asyncHandler(async (req, res) => {
  const body = consentSchema.parse(req.body);
  res.json(await familyService.setConsent(req.user!, String(req.params.relationshipId), body));
}));

familyRouter.get('/emergency-contacts', asyncHandler(async (req, res) => {
  res.json(await familyService.listContacts(req.user!));
}));

familyRouter.post('/emergency-contacts', asyncHandler(async (req, res) => {
  const body = contactSchema.parse(req.body);
  res.status(201).json(await familyService.createContact(req.user!, body));
}));

familyRouter.delete('/emergency-contacts/:contactId', asyncHandler(async (req, res) => {
  await familyService.deleteContact(req.user!, String(req.params.contactId));
  res.status(204).send();
}));

familyRouter.get('/privacy', asyncHandler(async (req, res) => {
  res.json(await familyService.getPrivacy(req.user!));
}));

familyRouter.patch('/privacy', asyncHandler(async (req, res) => {
  const body = privacySchema.parse(req.body);
  res.json(await familyService.patchPrivacy(req.user!, body));
}));
