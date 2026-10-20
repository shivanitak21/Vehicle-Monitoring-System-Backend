import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, auth, registerUser } from './helpers';

describe('authentication', () => {
  it('registers, logs in, refreshes, and logs out', async () => {
    const registered = await registerUser({ name: 'Ada Guardian', email: 'ada@example.com', role: 'guardian' });
    expect(registered.token).toBe(registered.accessToken);
    expect(registered.user.role).toBe('guardian');
    expect(registered.user.familyGroupId).toBeTruthy();

    const me = await request(app).get('/api/v1/auth/me').set(auth(registered.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('ada@example.com');

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'ada@example.com', password: 'password123' });
    expect(login.status).toBe(200);

    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);

    const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(reuse.status).toBe(401);

    const rotatedAfterReuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshed.body.refreshToken });
    expect(rotatedAfterReuse.status).toBe(401);

    const again = await request(app).post('/api/v1/auth/login').send({ email: 'ada@example.com', password: 'password123' });
    const logout = await request(app).post('/api/v1/auth/logout').set(auth(again.body.accessToken));
    expect(logout.status).toBe(204);
    const afterLogout = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: again.body.refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it('rejects administrator self-registration and duplicate emails', async () => {
    const admin = await request(app).post('/api/v1/auth/register').send({
      name: 'Root',
      email: 'root@example.com',
      password: 'password123',
      role: 'administrator',
    });
    expect(admin.status).toBe(422);

    await registerUser({ name: 'Sam', email: 'sam@example.com', role: 'passenger' });
    const duplicate = await request(app).post('/api/v1/auth/register').send({
      name: 'Sam',
      email: 'sam@example.com',
      password: 'password123',
      role: 'passenger',
    });
    expect(duplicate.status).toBe(409);
  });
});
