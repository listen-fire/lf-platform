// @lf/judge-llm: the judge slot's module. When a fuzzy write's search finds
// several candidates the structural rules cannot tell apart, a model (and,
// where a deployment has one, Jev) decides which record is the same entity.
// The engine holds only the slot (the host's `arbitrateEntities`); a shell
// fills it with `createIdentityJudge`, handing in its own model call.

export * from './judge';
