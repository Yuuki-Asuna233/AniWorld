const assert = require('assert');
const { mountAuthRoutes } = require('../../apps/server/src/routes/auth');

function createHarness() {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
    put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); }
  };
  let updatedPassword = null;
  const database = {
    getUserById(id) {
      return id === 7
        ? { id: 7, password_hash: 'hash:old-password' }
        : null;
    },
    updatePassword(id, hash) {
      updatedPassword = { id, hash };
      return true;
    }
  };
  const bcrypt = {
    compareSync(value, hash) { return hash === `hash:${value}`; },
    hashSync(value) { return `hash:${value}`; }
  };
  mountAuthRoutes(app, {
    database,
    bcrypt,
    jwt: { sign() { return 'token'; } },
    sendVerificationEmail: async () => {},
    avatarUpload: { single() { return (_req, _res, next) => next(); } },
    JWT_SECRET: 'test-secret',
    JWT_EXPIRES: '7d',
    requireAuth(_req, _res, next) { next(); }
  });
  return {
    handler: routes.get('POST /api/auth/change-password').at(-1),
    get updatedPassword() { return updatedPassword; }
  };
}

function invoke(handler, body) {
  const result = { status: 200, data: null };
  const req = { body, user: { id: 7 } };
  const res = {
    status(code) { result.status = code; return this; },
    json(data) { result.data = data; return this; }
  };
  handler(req, res);
  return result;
}

{
  const harness = createHarness();
  const response = invoke(harness.handler, {
    currentPassword: 'wrong',
    newPassword: 'new-password',
    confirmPassword: 'new-password'
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, '当前密码错误');
  assert.strictEqual(harness.updatedPassword, null);
}

{
  const harness = createHarness();
  const response = invoke(harness.handler, {
    currentPassword: 'old-password',
    newPassword: 'old-password',
    confirmPassword: 'old-password'
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, '新密码不能与当前密码相同');
}

{
  const harness = createHarness();
  const response = invoke(harness.handler, {
    currentPassword: 'old-password',
    newPassword: 'new-password',
    confirmPassword: 'new-password'
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.success, true);
  assert.deepStrictEqual(harness.updatedPassword, {
    id: 7,
    hash: 'hash:new-password'
  });
}

console.log('auth regression: ok');
