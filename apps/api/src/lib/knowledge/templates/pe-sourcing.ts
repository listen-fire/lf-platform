import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import { OntologyTemplate, prop, edge, fuzzy, exact } from './types';

const peSourcing: OntologyTemplate = {
  key: 'pe-sourcing',
  name: 'PE Sourcing',
  description:
    'Track companies, deals, contacts, and funds from sourcing communications',
  preview: ['Company', 'Deal', 'Contact', 'Fund'],

  nodeTypes: [
    {
      key: 'sourcing_message',
      name: 'Sourcing Message',
      description:
        'An inbound sourcing communication containing information about potential acquisition targets or deal opportunities',
      category: 'message',
      displayNameTemplate: 'Sourcing: {Mentions Company}',
      properties: [],
    },

    {
      key: 'company',
      name: 'Company',
      description:
        'A target company or portfolio company. Resolved globally by name or website',
      category: 'object',
      unique: [[exact(prop('company_website'))], [fuzzy(prop('company_name'))]],
      properties: [
        {
          key: 'company_name',
          name: 'Name',
          description: "The company's name",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'company_website',
          name: 'Website',
          description: "The company's primary website domain",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'company_description',
          name: 'Description',
          description:
            'What the company does — its business, market position, and key metrics',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'company_sector',
          name: 'Sector',
          description:
            'The company\'s industry sector (e.g. Healthcare, Technology, Industrials)',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'company_revenue',
          name: 'Revenue',
          description: "The company's annual revenue in USD",
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'company_ebitda',
          name: 'EBITDA',
          description: "The company's EBITDA in USD",
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'contact',
      name: 'Contact',
      description:
        'A person involved in the deal process — banker, advisor, executive, or referral source. Resolved globally by email or name',
      category: 'object',
      unique: [[exact(prop('contact_email'))], [fuzzy(prop('contact_name'))]],
      properties: [
        {
          key: 'contact_name',
          name: 'Name',
          description: "The contact's full name",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'contact_email',
          name: 'Email',
          description: "The contact's email address",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'contact_firm',
          name: 'Firm',
          description:
            'The firm or organization the contact represents',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'fund',
      name: 'Fund',
      description:
        'An investment fund — either ours or a co-investor. Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('fund_name'))]],
      properties: [
        {
          key: 'fund_name',
          name: 'Name',
          description: "The fund's name",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'deal',
      name: 'Deal',
      description:
        'A specific deal or transaction opportunity for a company. Scoped to the company — each company may have multiple deal processes over time',
      category: 'object',
      displayNameTemplate: '{At Company} — {Type}',
      unique: [[fuzzy(prop('deal_type')), exact(edge('deal_at_company', 'outgoing'))]],
      properties: [
        {
          key: 'deal_type',
          name: 'Type',
          description:
            'The type of deal — Buyout, Growth, Recapitalization, Add-on, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'deal_status',
          name: 'Status',
          description:
            'Current deal status — Active, Passed, Closed, Under LOI, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'deal_ev',
          name: 'Enterprise Value',
          description:
            'The expected or quoted enterprise value in USD',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
  ],

  edgeTypes: [
    {
      key: 'mentions_company',
      outboundName: 'Mentions Company',
      inboundName: 'Mentioned In Messages',
      description: 'The message mentions or describes this company',
      source: 'sourcing_message',
      target: 'company',
      required: false,
    },
    {
      key: 'deal_at_company',
      outboundName: 'At Company',
      inboundName: 'Deals',
      description: 'The company this deal is for',
      source: 'deal',
      target: 'company',
      required: true,
    },
    {
      key: 'deal_sourced_by',
      outboundName: 'Sourced By',
      inboundName: 'Sourced Deals',
      description:
        'The contact who sourced or presented this deal',
      source: 'deal',
      target: 'contact',
      required: false,
    },
    {
      key: 'deal_coinvestor',
      outboundName: 'Has Coinvestor',
      inboundName: 'Coinvesting In',
      description:
        'A fund that is co-investing or has expressed interest',
      source: 'deal',
      target: 'fund',
      required: false,
    },
  ],
};

export { peSourcing };
