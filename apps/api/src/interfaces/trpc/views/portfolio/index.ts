import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { userProcedure as sharedUserProcedure } from '../../procedures';
import { companyRouter } from './company';
import { decidesEach, type Decision } from '../../../access_route';

const portfolioRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    company: companyRouter(userProcedure),
  });
};

const EXEMPTION: Decision = { exempt: 'portfolio data, no automation' };

decidesEach('portfolio.company', {
  getAllPortfolios: EXEMPTION,
  convertTransaction: EXEMPTION,
  getOverview: EXEMPTION,
  addDividends: EXEMPTION,
  addFundDistribution: EXEMPTION,
  removeMarkdown: EXEMPTION,
  removePrice: EXEMPTION,
  updatePrice: EXEMPTION,
  addPrice: EXEMPTION,
  getPriceAssetOptions: EXEMPTION,
  updateAssetTransfer: EXEMPTION,
  updateRoundInfo: EXEMPTION,
  removeEvent: EXEMPTION,
  addAcquisition: EXEMPTION,
  getAcquisitionTransactions: EXEMPTION,
  addCashflowsToTransaction: EXEMPTION,
  addSecondarySale: EXEMPTION,
  addLiquidation: EXEMPTION,
  addShareSplit: EXEMPTION,
  getOutstandingCommitments: EXEMPTION,
  addFundDrawdown: EXEMPTION,
  getEventHistory: EXEMPTION,
  addMarkdown: EXEMPTION,
  updateCompanyInfo: EXEMPTION,
  addInvestment: EXEMPTION,
  addRound: EXEMPTION,
  getRoundNamesForLegalEntity: EXEMPTION,
  getInvestorsSummary: EXEMPTION,
  deleteNote: EXEMPTION,
  addPriceNote: EXEMPTION,
  addEventNote: EXEMPTION,
  addInvestmentNote: EXEMPTION,
  addTransactionNote: EXEMPTION,
  addInvestorToEvent: EXEMPTION,
  removeInvestorFromEvent: EXEMPTION,
  findInvestableEntitiesByName: EXEMPTION,
  findInvestingEntitiesByName: EXEMPTION,
  getSPVsForEntity: EXEMPTION,
  getOtherInvestors: EXEMPTION,
  getLegalEntities: EXEMPTION,
  getFundingChangelog: EXEMPTION,
  getChangelogCategories: EXEMPTION,
  getChangelogList: EXEMPTION,
  getChangelogCSV: EXEMPTION,
});

export { portfolioRouter };
