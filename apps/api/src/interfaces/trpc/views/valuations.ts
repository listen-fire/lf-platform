import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { queryValuations, valuationQueryInput } from '../../../lib/valuations/query';
import { decidesEach, type Decision } from '../../access_route';

/**
 * The valuation query surface: one query over the roll-up's leaf lots, filtered
 * and grouped by the caller.
 *
 * Every portfolio metric is a preset over these atoms — invested is cash paid,
 * full realised is cash received, direct retained is degree-0 held value,
 * acquirer exposure is held value grouped by tracked entity — so this ships the
 * dimensions rather than a fixed set of columns.
 *
 * Two things are fixed and deliberately not parameters. Tense: cash is valued
 * at the rate on the day it moved and never moves again, held positions always
 * at the analysis date, so there is no separate FX date to pass. Scope: an
 * investment filter admits the lots the roll-up attributed TO those
 * investments; flows it assigned to other investments sharing the same holdings
 * are nobody's answer here.
 */
const valuationsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    query: userProcedure.input(valuationQueryInput).query(({ input }) => queryValuations(input)),
  });
};

const EXEMPTION: Decision = { exempt: 'valuation data, no automation' };

decidesEach('valuations', {
  query: EXEMPTION,
});

export { valuationsRouter };
