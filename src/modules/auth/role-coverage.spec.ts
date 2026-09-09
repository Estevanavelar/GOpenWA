import 'reflect-metadata';
import { REQUIRED_ROLE_KEY } from './decorators/auth.decorators';
import { ApiKeyRole } from './entities/api-key.entity';
import { IntegrationInstanceController } from '../integration/integration-instance.controller';
import { RedriveController } from '../integration/redrive.controller';
import { GroupController } from '../group/group.controller';

// The dashboard's client-side role (seeded from localStorage) is cosmetic UX only — the ACTUAL
// authorization boundary is the backend @RequireRole guard. These assertions lock that the sensitive
// ADMIN-only integration provisioning / redrive surfaces are role-gated server-side at the class level,
// so a tampered client role can never reach them regardless of what the browser claims.
describe('admin controller role coverage (server-side authorization is the real gate)', () => {
  it.each([
    ['IntegrationInstanceController', IntegrationInstanceController],
    ['RedriveController', RedriveController],
  ])('%s requires the ADMIN role at the class level', (_name, controller) => {
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, controller)).toBe(ApiKeyRole.ADMIN);
  });
});

// A group invite code is a bearer capability, not read data: whoever holds the link joins the group
// on WhatsApp with no OpenWA credential at all, and that membership survives revoking the key that
// fetched the code. Both invite-code routes therefore sit at OPERATOR, like the QR endpoint: the
// reads whose payload is a credential for a system outside OpenWA's authority.
describe('group invite-code role coverage (the code is a capability, not read data)', () => {
  it.each(['getInviteCode', 'revokeInviteCode'] as const)('GroupController.%s requires the OPERATOR role', method => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, GroupController.prototype[method])).toBe(ApiKeyRole.OPERATOR);
  });
});
