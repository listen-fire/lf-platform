import type { Expression } from 'movement-lang/expression/types';

import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyCardinality from '../../../generated/kysely/knowledge/PropertyCardinality';

type EdgeFilter = {
  side: 'source' | 'target';
  property: string;
  value: string;
};

type TemplatePropertyDef = {
  key: string;
  name: string;
  description: string;
  valueType: PropertyValueType;
  evaluationStrategy: EvaluationStrategy;
  cardinality?: PropertyCardinality;
  enumValues?: string[];
};

// ── Uniqueness constraints ──

type TemplateConstraintEntry = {
  expr: Expression;
  fuzzy?: boolean;
};

type TemplateUniquenessConstraint = TemplateConstraintEntry[];

type TemplateNodeType = {
  key: string;
  name: string;
  description: string;
  category: 'message' | 'object';
  properties: TemplatePropertyDef[];
  unique?: TemplateUniquenessConstraint[];
  iconSvg?: string;
  displayNameTemplate?: string;
  displayNameExpression?: Expression;
};

type TemplateEdgeType = {
  key: string;
  outboundName: string;
  inboundName: string;
  description: string;
  source: string;
  target: string;
  required: boolean;
  filters?: EdgeFilter[];
  group?: string;
  properties?: TemplatePropertyDef[];
};

// ── Constraint expression helpers ──

function prop(propertyKey: string): Expression {
  return { type: 'property', propertyTypeId: propertyKey };
}

function edge(edgeKey: string, direction: 'outgoing' | 'incoming' = 'outgoing'): Expression {
  return {
    type: 'traverse',
    steps: [{ type: 'edge', edgeTypeId: edgeKey, direction }],
    expression: { type: 'static', value: true },
  };
}

function fuzzy(expr: Expression): TemplateConstraintEntry {
  return { expr, fuzzy: true };
}

function exact(expr: Expression): TemplateConstraintEntry {
  return { expr };
}

type OntologyTemplate = {
  key: string;
  name: string;
  description: string;
  preview: string[];
  nodeTypes: TemplateNodeType[];
  edgeTypes: TemplateEdgeType[];
};

export { prop, edge, fuzzy, exact };

export type {
  OntologyTemplate,
  TemplateNodeType,
  TemplateEdgeType,
  TemplatePropertyDef,
  TemplateConstraintEntry,
  TemplateUniquenessConstraint,
  EdgeFilter,
};
