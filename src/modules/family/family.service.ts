import { Types } from 'mongoose';
import { AppError, NotFoundError } from '../../common/errors/app-error';
import type { AuthenticatedUser } from '../../common/middleware/authenticate';
import { EmergencyContactModel, FamilyGroupModel, FamilyRelationshipModel, type FamilyRelationshipDocument } from '../../models/family';
import { UserModel } from '../../models/user';
import { writeAudit } from '../audit/audit.service';
import { updatePrivacy } from '../auth/auth.service';

function requireFamily(user: AuthenticatedUser): string {
  if (user.role === 'administrator') {
    throw new AppError(400, 'FAMILY_REQUIRED', 'Choose a family account. Administrator tokens are not members of a family.');
  }
  if (!user.familyGroupId || user.role !== 'guardian') {
    throw new AppError(403, 'FORBIDDEN', 'Only a guardian in a family can manage that circle');
  }
  return user.familyGroupId;
}

export async function getFamily(user: AuthenticatedUser) {
  if (!user.familyGroupId) throw new NotFoundError('Family not found');
  const group = await FamilyGroupModel.findById(user.familyGroupId);
  if (!group) throw new NotFoundError('Family not found');
  const members = await FamilyRelationshipModel.find({ familyGroupId: group._id });
  return {
    id: group.id,
    name: group.name,
    ownerId: group.ownerId.toString(),
    memberCount: members.length,
    members: members.map(presentMember),
  };
}

export async function listPassengers(user: AuthenticatedUser) {
  const family = await getFamily(user);
  return family.members.filter((member) => member.role === 'passenger');
}

export async function listMembers(user: AuthenticatedUser) {
  if (!user.familyGroupId) return [];
  const members = await FamilyRelationshipModel.find({ familyGroupId: user.familyGroupId });
  return members.map(presentMember);
}

export async function createMember(
  user: AuthenticatedUser,
  input: { name: string; relationship: string; phone: string; role: 'guardian' | 'passenger' | 'driver'; email?: string },
) {
  const familyGroupId = requireFamily(user);
  const email = input.email?.toLowerCase();
  const linked = email ? await UserModel.findOne({ email }) : null;
  if (input.role === 'guardian' && !linked) {
    throw new AppError(422, 'VALIDATION_ERROR', 'A guardian member must already have an account email');
  }
  if (linked?.role === 'administrator') throw new AppError(403, 'FORBIDDEN', 'Administrator accounts cannot be added to a family');
  const relationship = await FamilyRelationshipModel.create({
    familyGroupId,
    guardianId: input.role === 'guardian' && linked ? linked._id : user.id,
    passengerId: input.role === 'guardian' ? null : linked?._id ?? null,
    inviteEmail: email ?? '',
    displayName: input.name,
    phone: input.phone,
    relationship: input.relationship,
    memberRole: input.role,
    consentStatus: 'pending',
    sharingLocation: false,
    permissions: {
      viewLocation: true,
      viewTrips: true,
      viewIncidents: true,
      viewMedia: false,
      receiveAlerts: true,
    },
  });
  if (linked && !linked.familyGroupId && input.role !== 'guardian') {
    linked.familyGroupId = new Types.ObjectId(familyGroupId);
    await linked.save();
  }
  if (linked && input.role === 'guardian') {
    linked.familyGroupId = new Types.ObjectId(familyGroupId);
    await linked.save();
    await FamilyGroupModel.updateOne({ _id: familyGroupId }, { $addToSet: { memberIds: linked._id } });
  }
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'family.member_create', resourceType: 'family_relationship', resourceId: relationship.id, decision: 'allow' });
  return presentMember(relationship);
}

export async function removeMember(user: AuthenticatedUser, memberId: string) {
  const familyGroupId = requireFamily(user);
  if (!Types.ObjectId.isValid(memberId)) throw new NotFoundError('Family member not found');
  const relationship = await FamilyRelationshipModel.findOne({ _id: memberId, familyGroupId });
  if (!relationship) throw new NotFoundError('Family member not found');
  relationship.consentStatus = 'revoked';
  relationship.revokedAt = new Date();
  relationship.sharingLocation = false;
  await relationship.save();
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'family.member_revoke', resourceType: 'family_relationship', resourceId: relationship.id, decision: 'allow' });
}

export async function setConsent(
  user: AuthenticatedUser,
  relationshipId: string,
  input: { status: 'granted' | 'revoked'; sharingLocation?: boolean },
) {
  if (!Types.ObjectId.isValid(relationshipId)) throw new NotFoundError('Family relationship not found');
  const relationship = await FamilyRelationshipModel.findById(relationshipId);
  if (!relationship) throw new NotFoundError('Family relationship not found');
  const isSubject = relationship.passengerId?.toString() === user.id;
  const isResponsibleGuardian = user.role === 'guardian' && user.familyGroupId === relationship.familyGroupId.toString();
  if (user.role !== 'administrator' && !isSubject && !isResponsibleGuardian) throw new NotFoundError('Family relationship not found');
  if (input.status === 'granted' && !isSubject && user.role !== 'administrator') {
    throw new AppError(403, 'CONSENT_REQUIRED', 'Only the passenger can grant consent');
  }
  relationship.consentStatus = input.status;
  relationship.revokedAt = input.status === 'revoked' ? new Date() : null;
  relationship.sharingLocation = input.status === 'granted' ? input.sharingLocation ?? true : false;
  await relationship.save();
  await writeAudit({
    actorId: user.id,
    actorRole: user.role,
    action: 'family.consent',
    resourceType: 'family_relationship',
    resourceId: relationship.id,
    decision: 'allow',
    metadata: { status: input.status },
  });
  return presentMember(relationship);
}

export async function listContacts(user: AuthenticatedUser) {
  if (!user.familyGroupId) return [];
  const contacts = await EmergencyContactModel.find({ familyGroupId: user.familyGroupId });
  return contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    relationship: contact.relationship,
    phone: contact.phone,
  }));
}

export async function createContact(user: AuthenticatedUser, input: { name: string; relationship: string; phone: string }) {
  const familyGroupId = requireFamily(user);
  const contact = await EmergencyContactModel.create({ ...input, familyGroupId, ownerId: user.id });
  return { id: contact.id, name: contact.name, relationship: contact.relationship, phone: contact.phone };
}

export async function deleteContact(user: AuthenticatedUser, contactId: string) {
  const familyGroupId = requireFamily(user);
  if (!Types.ObjectId.isValid(contactId)) throw new NotFoundError('Emergency contact not found');
  const result = await EmergencyContactModel.deleteOne({ _id: contactId, familyGroupId });
  if (result.deletedCount === 0) throw new NotFoundError('Emergency contact not found');
}

export async function getPrivacy(user: AuthenticatedUser) {
  const record = await UserModel.findById(user.id);
  if (!record) throw new NotFoundError('User not found');
  return record.privacy;
}

export async function patchPrivacy(user: AuthenticatedUser, privacy: Record<string, boolean>) {
  return updatePrivacy(user.id, privacy);
}

function presentMember(member: FamilyRelationshipDocument) {
  return {
    id: member.id,
    name: member.displayName,
    relationship: member.relationship,
    role: member.memberRole,
    phone: member.phone,
    consent: member.consentStatus,
    sharingLocation: member.sharingLocation,
    guardianId: member.guardianId.toString(),
    passengerId: member.passengerId ? member.passengerId.toString() : null,
    permissions: member.permissions,
    revokedAt: member.revokedAt ?? null,
  };
}
