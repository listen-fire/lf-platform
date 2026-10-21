// The record handle: what a movement value that stands for a record (or a
// node, a deferred walk, a write) is while a run holds it, and the scope that
// binds names to such values. Every engine makes and reads the one handle.

export {
  Environment,
  binding,
  bindingOf,
  isCallableBinding,
  type Binding,
  type BindingShape,
  type Bound,
  type DeferredWalk,
  type ExtractEmission,
  type HandleGraph,
  type NodeEdge,
  type SourceRead,
  type WriteRecord,
} from '../services/movement_engine/binding';
