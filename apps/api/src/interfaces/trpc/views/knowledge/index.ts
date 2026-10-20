import { trpc } from '../../trpc';
import { ontologyRouter } from './ontology';
import { graphRouter } from './graph';
import { recipeRouter } from './recipe';
import { cypherAgentRouter } from './cypherAgent';

const knowledgeRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    ontology: ontologyRouter(procedure),
    graph: graphRouter(procedure),
    recipe: recipeRouter(procedure),
    cypherAgent: cypherAgentRouter(procedure),
  });

export { knowledgeRouter };
