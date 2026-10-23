import { accountRouter } from './account';
import { adaptersRouter } from './adapters';
import { adminRouter } from './admin';
import { apiKeysRouter } from './apiKeys';
import { attachmentRouter } from './attachment';
import { connectionsRouter } from './connections';
import { credentialsRouter } from './credentials';
import { controlTowerRouter } from './controlTower';
import { googleSheetsRouter } from './googleSheets';
import { graphExplorerRouter } from './graphExplorer';
import { handbookRouter } from './handbook';
import { homeRouter } from './home';
import { investmentsRouter } from './investments';
import { journeyRouter } from './journey';
import { knowledgeRouter } from './knowledge';
import { movementRouter } from './movement';
import { noteRouter } from './note';
import { opsRouter } from './ops';
import { pluginsRouter } from './plugins';
import { portfolioRouter } from './portfolio';
import { remoteAdapterRouter } from './remoteAdapter';
import { triggersRouter } from './triggers';
import { trpc } from '../trpc';
import { productGateMiddleware } from '../product_gate';
import { usageRouter } from './usage';
import { valuationsRouter } from './valuations';
import { userSettingsRouter } from './userSettings';
import { webhookSubscriptionsRouter } from './webhookSubscriptions';
import { teamEngineRouter } from './teamEngine';
import { teamMembersRouter } from './teamMembers';
import { testHarnessRouter } from './testHarness';

// Every view procedure carries the product gate. The router TREE stays whole
// (packages/trpc generates one .d.ts from it for every frontend), so a
// process that does not run a product refuses that product's procedures one by
// one rather than declining to declare them — see product_gate.ts.
const gatedProcedure = trpc.procedure.use(productGateMiddleware);

const viewsRouter = trpc.router({
  account: accountRouter(gatedProcedure),
  adapters: adaptersRouter(gatedProcedure),
  admin: adminRouter(gatedProcedure),
  apiKeys: apiKeysRouter(gatedProcedure),
  attachments: attachmentRouter(gatedProcedure),
  connections: connectionsRouter(gatedProcedure),
  credentials: credentialsRouter(gatedProcedure),
  controlTower: controlTowerRouter(gatedProcedure),
  googleSheets: googleSheetsRouter(gatedProcedure),
  graphExplorer: graphExplorerRouter(gatedProcedure),
  handbook: handbookRouter(gatedProcedure),
  home: homeRouter(gatedProcedure),
  investments: investmentsRouter(gatedProcedure),
  journey: journeyRouter(gatedProcedure),
  knowledge: knowledgeRouter(gatedProcedure),
  movement: movementRouter(gatedProcedure),
  note: noteRouter(gatedProcedure),
  ops: opsRouter(gatedProcedure),
  plugins: pluginsRouter(gatedProcedure),
  portfolio: portfolioRouter(gatedProcedure),
  remoteAdapter: remoteAdapterRouter(gatedProcedure),
  triggers: triggersRouter(gatedProcedure),
  teamEngine: teamEngineRouter(gatedProcedure),
  teamMembers: teamMembersRouter(gatedProcedure),
  usage: usageRouter(gatedProcedure),
  valuations: valuationsRouter(gatedProcedure),
  userSettings: userSettingsRouter(gatedProcedure),
  webhookSubscriptions: webhookSubscriptionsRouter(gatedProcedure),
  testHarness: testHarnessRouter(gatedProcedure),
});

export { viewsRouter };
