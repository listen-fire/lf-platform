import { trpc } from '../../trpc';
import { ontologyRouter } from './ontology';
import { graphRouter } from './graph';
import { queryAgentRouter } from './queryAgent';
import { ontologyAgentRouter } from './ontologyAgent';
import { systemAgentRouter } from './systemAgent';
import { recipeRouter } from './recipe';
import { cypherAgentRouter } from './cypherAgent';

const knowledgeRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    ontology: ontologyRouter(procedure),
    graph: graphRouter(procedure),
    queryAgent: queryAgentRouter(procedure),
    ontologyAgent: ontologyAgentRouter(procedure),
    systemAgent: systemAgentRouter(procedure),
    recipe: recipeRouter(procedure),
    cypherAgent: cypherAgentRouter(procedure),
  });

export { knowledgeRouter };
