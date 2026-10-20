import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import { OntologyTemplate } from './types';
import { prop, edge, fuzzy, exact } from './types';

const clinicalTrials: OntologyTemplate = {
  key: 'clinical-trials',
  name: 'Clinical Trials',
  description:
    'Track drugs, companies, trials, and results from biotech/pharma communications',
  preview: ['Drug', 'Company', 'Trial', 'Researcher'],

  nodeTypes: [
    {
      key: 'pharma_update',
      name: 'Pharma Update',
      description:
        'A communication containing clinical trial information — press release, FDA filing summary, journal abstract, or analyst note',
      category: 'message',
      displayNameTemplate: 'Update: {Mentions Drug}',
      properties: [],
    },

    {
      key: 'drug',
      name: 'Drug',
      description:
        'A drug, compound, or therapy being developed. Resolved globally by name or identifier (e.g. BNT162b2, pembrolizumab)',
      category: 'object',
      unique: [[fuzzy(prop('drug_name'))]],
      properties: [
        {
          key: 'drug_name',
          name: 'Name',
          description: 'The drug name — brand name, generic name, or compound identifier',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'drug_mechanism',
          name: 'Mechanism of Action',
          description: 'How the drug works — e.g. PD-1 inhibitor, mRNA vaccine, SGLT2 inhibitor',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'drug_modality',
          name: 'Modality',
          description: 'Drug type — small molecule, biologic, cell therapy, gene therapy, mRNA, ADC, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'pharma_company',
      name: 'Company',
      description:
        'A pharmaceutical or biotech company. Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('pharma_company_name'))]],
      properties: [
        {
          key: 'pharma_company_name',
          name: 'Name',
          description: "The company's name",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'researcher',
      name: 'Researcher',
      description:
        'A principal investigator, lead researcher, or key opinion leader. Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('researcher_name'))]],
      properties: [
        {
          key: 'researcher_name',
          name: 'Name',
          description: "The researcher's full name",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'researcher_affiliation',
          name: 'Affiliation',
          description: 'Institution or hospital where the researcher is based',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'indication',
      name: 'Indication',
      description:
        'A disease, condition, or therapeutic area being targeted (e.g. NSCLC, Type 2 Diabetes, Major Depressive Disorder). Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('indication_name'))]],
      properties: [
        {
          key: 'indication_name',
          name: 'Name',
          description: 'The disease or condition name',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'trial',
      name: 'Trial',
      description:
        'A specific clinical trial. Scoped to its parent drug — a Phase III trial for Drug A is different from Phase III for Drug B',
      category: 'object',
      unique: [
        [exact(prop('trial_name')), exact(edge('trial_for_drug', 'outgoing'))],
        [fuzzy(prop('trial_phase')), exact(edge('trial_for_drug', 'outgoing'))],
      ],
      displayNameTemplate: '{For Drug} — {Phase}',
      properties: [
        {
          key: 'trial_name',
          name: 'Trial Name',
          description: 'The trial name or identifier (e.g. KEYNOTE-024, NCT04368728)',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'trial_phase',
          name: 'Phase',
          description: 'Clinical trial phase — Phase I, Phase II, Phase III, Phase IV',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'trial_patients',
          name: 'Patient Count',
          description: 'Number of patients enrolled in the trial',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'trial_status',
          name: 'Status',
          description: 'Current trial status — recruiting, active, completed, terminated, FDA review',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    {
      key: 'trial_result',
      name: 'Trial Result',
      description:
        'A reported result or data readout from a trial. Scoped to the parent trial',
      category: 'object',
      unique: [[fuzzy(prop('result_endpoint')), exact(edge('trial_result_from_trial', 'outgoing'))]],
      displayNameTemplate: '{From Trial} — {Endpoint}',
      properties: [
        {
          key: 'result_endpoint',
          name: 'Endpoint',
          description: 'The primary or secondary endpoint measured (e.g. overall survival, progression-free survival, ORR)',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'result_outcome',
          name: 'Outcome',
          description: 'The result — met/missed endpoint, hazard ratio, p-value, response rate, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },
  ],

  edgeTypes: [
    {
      key: 'update_mentions_drug',
      outboundName: 'Mentions Drug',
      inboundName: 'Mentioned In Updates',
      description: 'A drug mentioned in this update',
      source: 'pharma_update',
      target: 'drug',
      required: false,
    },
    {
      key: 'drug_developed_by',
      outboundName: 'Developed By',
      inboundName: 'Develops',
      description: 'The company developing or sponsoring this drug',
      source: 'drug',
      target: 'pharma_company',
      required: false,
    },
    {
      key: 'drug_targets_indication',
      outboundName: 'Targets Indication',
      inboundName: 'Targeted By Drugs',
      description: 'A disease or condition this drug is being developed for',
      source: 'drug',
      target: 'indication',
      required: false,
    },
    {
      key: 'trial_for_drug',
      outboundName: 'For Drug',
      inboundName: 'Trials',
      description: 'The drug this trial is testing',
      source: 'trial',
      target: 'drug',
      required: true,
    },
    {
      key: 'trial_led_by',
      outboundName: 'Led By',
      inboundName: 'Leads Trials',
      description: 'The principal investigator for this trial',
      source: 'trial',
      target: 'researcher',
      required: false,
    },
    {
      key: 'trial_result_from_trial',
      outboundName: 'From Trial',
      inboundName: 'Results',
      description: 'The trial this result came from',
      source: 'trial_result',
      target: 'trial',
      required: true,
    },
  ],
};

export { clinicalTrials };
