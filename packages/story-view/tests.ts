import type { FilterOperator } from "movement-lang/expression/types";

/**
 * How each test the language has reads out loud.
 *
 * One table, used by everything that shows a predicate — a traversal's WHERE
 * and a branch's condition are the same question asked in two places, and two
 * tables would have drifted the first time the language gained an operator.
 *
 * `reads: false` for the one test that has nothing on its right-hand side —
 * showing a value there would invent one.
 */
export const TESTS: Record<FilterOperator, { verb: string; reads: boolean }> = {
  eq: { verb: "is", reads: true },
  neq: { verb: "is not", reads: true },
  contains: { verb: "contains", reads: true },
  gt: { verb: "is more than", reads: true },
  gte: { verb: "is at least", reads: true },
  lt: { verb: "is less than", reads: true },
  lte: { verb: "is at most", reads: true },
  in: { verb: "is one of", reads: true },
  within: { verb: "is within the last", reads: true },
  exists: { verb: "has anything in it", reads: false },
};
