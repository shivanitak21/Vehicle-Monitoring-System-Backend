import { Types } from 'mongoose';
import { NotFoundError } from '../../common/errors/app-error';
import type { AuthenticatedUser } from '../../common/middleware/authenticate';
import { FamilyRelationshipModel, type FamilyRelationshipDocument } from '../../models/family';
import { IncidentModel, type IncidentDocument } from '../../models/incident';
import { MediaAssetModel, type MediaAssetDocument } from '../../models/incident';
import { TripModel, type TripDocument } from '../../models/trip';
import { VehicleModel, type VehicleDocument } from '../../models/vehicle';
import { writeAudit } from '../audit/audit.service';

function validId(id: string): boolean {
  return Types.ObjectId.isValid(id);
}

async function deny(user: AuthenticatedUser, action: string, resourceType: string, resourceId: string): Promise<void> {
  await writeAudit({
    actorId: user.id,
    actorRole: user.role,
    action,
    resourceType,
    resourceId,
    decision: 'deny',
  });
}

export async function grantedRelationshipsForGuardian(guardianId: string): Promise<FamilyRelationshipDocument[]> {
  return FamilyRelationshipModel.find({
    guardianId,
    consentStatus: 'granted',
    revokedAt: null,
    'permissions.viewTrips': true,
  });
}

export async function relationshipBetween(guardianId: string, passengerId: string): Promise<FamilyRelationshipDocument | null> {
  return FamilyRelationshipModel.findOne({
    guardianId,
    passengerId,
    consentStatus: 'granted',
    revokedAt: null,
  });
}

export function tripQueryFor(user: AuthenticatedUser, passengerIds: string[]) {
  if (user.role === 'administrator') return {};
  return {
    $or: [
      { passengerId: user.id },
      { driverId: user.id },
      { passengerId: { $in: passengerIds }, authorizedGuardianIds: user.id },
    ],
  };
}

export async function assertTripAccess(user: AuthenticatedUser, tripId: string, action = 'trip.view'): Promise<TripDocument> {
  if (!validId(tripId)) throw new NotFoundError('Trip not found');
  const trip = await TripModel.findById(tripId);
  if (!trip) throw new NotFoundError('Trip not found');
  if (user.role === 'administrator') {
    await writeAudit({ actorId: user.id, actorRole: user.role, action, resourceType: 'trip', resourceId: tripId, decision: 'allow' });
    return trip;
  }
  if (trip.passengerId.toString() === user.id || trip.driverId?.toString() === user.id) return trip;
  const relationship = await relationshipBetween(user.id, trip.passengerId.toString());
  const listed = trip.authorizedGuardianIds.some((id) => id.toString() === user.id);
  if (relationship && listed && relationship.permissions.viewTrips) return trip;
  await deny(user, action, 'trip', tripId);
  throw new NotFoundError('Trip not found');
}

export async function canSeeLocation(user: AuthenticatedUser, trip: TripDocument): Promise<boolean> {
  if (user.role === 'administrator') return true;
  if (trip.passengerId.toString() === user.id) return true;
  if (!trip.sharing?.shareLocation) return false;
  const relationship = await relationshipBetween(user.id, trip.passengerId.toString());
  if (!relationship) return trip.driverId?.toString() === user.id;
  const listed = trip.authorizedGuardianIds.some((id) => id.toString() === user.id);
  return Boolean(relationship.permissions.viewLocation && relationship.sharingLocation && trip.sharing?.shareLocation && listed);
}

export async function assertVehicleAccess(user: AuthenticatedUser, vehicleId: string, mode: 'read' | 'write'): Promise<VehicleDocument> {
  if (!validId(vehicleId)) throw new NotFoundError('Vehicle not found');
  const vehicle = await VehicleModel.findById(vehicleId);
  if (!vehicle) throw new NotFoundError('Vehicle not found');
  if (user.role === 'administrator') return vehicle;
  const sameFamily = user.familyGroupId && vehicle.familyGroupId.toString() === user.familyGroupId;
  if (sameFamily && user.role === 'guardian') return vehicle;
  if (mode === 'read' && vehicle.assignedDriverId?.toString() === user.id) return vehicle;
  if (mode === 'read') {
    const trip = await TripModel.exists({ vehicleId: vehicle._id, passengerId: user.id });
    if (trip) return vehicle;
  }
  await deny(user, mode === 'write' ? 'vehicle.write' : 'vehicle.read', 'vehicle', vehicleId);
  throw new NotFoundError('Vehicle not found');
}

export async function assertIncidentAccess(user: AuthenticatedUser, incidentId: string): Promise<IncidentDocument> {
  if (!validId(incidentId)) throw new NotFoundError('Incident not found');
  const incident = await IncidentModel.findById(incidentId);
  if (!incident) throw new NotFoundError('Incident not found');
  await assertTripAccess(user, incident.tripId.toString(), 'incident.view');
  if (user.role === 'administrator' || incident.passengerId.toString() === user.id) return incident;
  const relationship = await relationshipBetween(user.id, incident.passengerId.toString());
  if (!relationship?.permissions.viewIncidents) {
    await deny(user, 'incident.view', 'incident', incidentId);
    throw new NotFoundError('Incident not found');
  }
  return incident;
}

export async function assertMediaAccess(user: AuthenticatedUser, mediaId: string): Promise<MediaAssetDocument> {
  if (!validId(mediaId)) throw new NotFoundError('Media not found');
  const media = await MediaAssetModel.findById(mediaId);
  if (!media || media.uploadState === 'deleted') throw new NotFoundError('Media not found');
  const incident = await assertIncidentAccess(user, media.incidentId.toString());
  if (user.role === 'administrator' || incident.passengerId.toString() === user.id) {
    await writeAudit({ actorId: user.id, actorRole: user.role, action: 'media.access', resourceType: 'media', resourceId: mediaId, decision: 'allow' });
    return media;
  }
  const relationship = await relationshipBetween(user.id, incident.passengerId.toString());
  const trip = await TripModel.findById(incident.tripId);
  if (!relationship?.permissions.viewMedia || !trip?.sharing?.shareMedia) {
    await deny(user, 'media.access', 'media', mediaId);
    throw new NotFoundError('Media not found');
  }
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'media.access', resourceType: 'media', resourceId: mediaId, decision: 'allow' });
  return media;
}

export async function recipientGuardians(trip: TripDocument): Promise<string[]> {
  const relationships = await FamilyRelationshipModel.find({
    passengerId: trip.passengerId,
    consentStatus: 'granted',
    revokedAt: null,
    'permissions.receiveAlerts': true,
  });
  const allowed = new Set(relationships.map((item) => item.guardianId.toString()));
  return trip.authorizedGuardianIds.map((id) => id.toString()).filter((id) => allowed.has(id));
}
