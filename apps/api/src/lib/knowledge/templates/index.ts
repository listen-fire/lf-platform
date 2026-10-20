import { vcDealflow } from './vc-dealflow';
import { peSourcing } from './pe-sourcing';
import { dndCampaign } from './dnd-campaign';
import { clinicalTrials } from './clinical-trials';
import { OntologyTemplate } from './types';

const templates: OntologyTemplate[] = [vcDealflow, peSourcing, dndCampaign, clinicalTrials];

function getTemplate(key: string): OntologyTemplate | undefined {
  return templates.find((t) => t.key === key);
}

export { templates, getTemplate };
export { prop, edge, fuzzy, exact } from './types';
export type {
  OntologyTemplate,
  TemplateNodeType,
  TemplateEdgeType,
  TemplatePropertyDef,
  TemplateConstraintEntry,
  TemplateUniquenessConstraint,
  EdgeFilter,
} from './types';
