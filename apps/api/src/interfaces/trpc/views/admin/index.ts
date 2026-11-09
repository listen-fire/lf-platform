import { trpc } from '../../trpc';
import { platformAdminProcedure } from '../../procedures';
import { legalEntityManagerRouter } from './legalEntityManager';
import { authenticateAsRouter } from './authenticateAs';
import { logsRouter } from './logs';
import { userManagementRouter } from './userManagement';
import { llmUsageRouter } from './llmUsage';
import { usageConfigRouter } from './usageConfig';
import { crossTeamOpsRouter } from './crossTeamOps';
import { signupsRouter } from './signups';
import { EXEMPT, decidesEach } from '../../../access_route';

const adminRouter = (procedure: typeof trpc.procedure) => {
  const adminProcedure = platformAdminProcedure(procedure);

  return trpc.router({
    legalEntityManager: legalEntityManagerRouter(adminProcedure),
    authenticateAs: authenticateAsRouter(adminProcedure),
    logs: logsRouter(adminProcedure),
    userManagement: userManagementRouter(adminProcedure),
    llmUsage: llmUsageRouter(adminProcedure),
    usageConfig: usageConfigRouter(adminProcedure),
    crossTeamOps: crossTeamOpsRouter(adminProcedure),
    signups: signupsRouter(adminProcedure),
  });
};

decidesEach('admin.legalEntityManager', {
  getTeams: EXEMPT.platformAdmin,
  getLegalEntitiesWithJargon: EXEMPT.platformAdmin,
  getPotentialMatches: EXEMPT.platformAdmin,
  updateEntity: EXEMPT.platformAdmin,
});
decidesEach('admin.authenticateAs', {
  usersByEmailPrefix: EXEMPT.platformAdmin,
});
decidesEach('admin.logs', {
  getLogsUrl: EXEMPT.platformAdmin,
});
decidesEach('admin.userManagement', {
  getTeams: EXEMPT.platformAdmin,
  setTeamDetailLevel: EXEMPT.platformAdmin,
  searchUsersByEmail: EXEMPT.platformAdmin,
  createTeamWithAdmin: EXEMPT.platformAdmin,
  addUserToTeam: EXEMPT.platformAdmin,
  createServiceAccount: EXEMPT.platformAdmin,
  grantTeamAccess: EXEMPT.platformAdmin,
  addEmailToUser: EXEMPT.platformAdmin,
  addPhoneNumberToUser: EXEMPT.platformAdmin,
  getUserContactInfo: EXEMPT.platformAdmin,
  updateUsername: EXEMPT.platformAdmin,
  moveUserToTeam: EXEMPT.platformAdmin,
  listUserMemberships: EXEMPT.platformAdmin,
  removeUserFromTeam: EXEMPT.platformAdmin,
});
decidesEach('admin.llmUsage', {
  summary: EXEMPT.platformAdmin,
  byModel: EXEMPT.platformAdmin,
  byLabel: EXEMPT.platformAdmin,
  byConversation: EXEMPT.platformAdmin,
  conversationDetail: EXEMPT.platformAdmin,
  teams: EXEMPT.platformAdmin,
});
decidesEach('admin.usageConfig', {
  getForTeam: EXEMPT.platformAdmin,
  upsert: EXEMPT.platformAdmin,
});
decidesEach('admin.crossTeamOps', {
  listTeams: EXEMPT.platformAdmin,
  listUsageAcrossTeams: EXEMPT.platformAdmin,
  getBillingContacts: EXEMPT.platformAdmin,
  setBillingContact: EXEMPT.platformAdmin,
});
decidesEach('admin.signups', {
  list: EXEMPT.platformAdmin,
});

export { adminRouter };
