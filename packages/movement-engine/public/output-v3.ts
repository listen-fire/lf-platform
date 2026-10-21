// The knowledge pipeline's v3 output shape: the config tree (nodes, steps,
// filters, selections) and the expression language its field mappings use.

export * from 'engine-contracts/expression/schemas';
export * from 'engine-contracts/expression/expression';
// Both stars carry a `FilterOperator` and a `TraversalStep`; this surface keeps
// meaning the schemas' own, as it did before the expression vocabulary was
// re-exported from the contract package.
export type { FilterOperator, TraversalStep } from 'engine-contracts/expression/schemas';
