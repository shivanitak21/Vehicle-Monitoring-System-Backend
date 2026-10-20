import type { UserRole } from '../models/user';

declare global {
  namespace Express {
    interface Request {
      id: string;
      user?: {
        id: string;
        role: UserRole;
        email: string;
        name: string;
        familyGroupId: string | null;
      };
    }
  }
}

export {};
