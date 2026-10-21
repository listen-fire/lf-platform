// Where a value came from: the origins a run's value carries (a record's
// field, an extraction site, a transform of either), how they combine, and
// how they are summarised into the evidence a write records.

export {
  NO_PROVENANCE,
  ProvenanceSummariser,
  fieldEvidenceFromProvenance,
  fromOrigin,
  transformed,
  unionProvenance,
  type ExtractSiteRef,
  type ExtractSiteSummary,
  type Provenance,
  type ProvenanceOrigin,
  type SummarisedOrigin,
} from '../services/movement_engine/provenance';
