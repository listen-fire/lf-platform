"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trpc } from "@/lib/trpc";
import { PropertyValueType, EvaluationStrategy } from "#trpc";
import type { EvidenceType } from "#trpc";
import { Select } from "@/components/select";
import type { Expression } from "movement-lang/expression/types";
import { serialize as formulaSerialize, getCompletions as formulaCompletions, type PropertyInfo, type EdgeInfo, type Completion as FormulaCompletion } from "movement-lang/expression/formula";
import { validate as formulaValidate, type ValidationResult as FormulaValidation } from "@listen-fire/legacy-engine/formula/parser";
import type {
  SummaryNodeType,
  SummaryEdgeType,
  SummaryPropertyType,
} from "./types";
import {
  parseConstraintText,
  serializeConstraint,
  type ConstraintEntry,
  type EdgeLookup,
} from "@/lib/uniqueness-constraints";
import { ConstraintInput } from "@/components/uniqueness-constraint-input";

const CATEGORY_BADGE: Record<string, string> = {
  message: "bg-orange-100 text-orange-700",
  object: "bg-blue-100 text-blue-700",
  scoped_object: "bg-blue-100 text-blue-700",
  property: "bg-purple-100 text-purple-700",
};

const CATEGORY_LABEL: Record<string, string> = {
  message: "message",
  object: "object",
  scoped_object: "object",
  property: "property",
};

// -- Enum Values Input --

function EnumValuesInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const addValue = () => {
    const trimmed = draft.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setDraft("");
  };

  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-gray-500">
        Enum Values
      </label>
      {values.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700"
            >
              {v}
              <button
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="text-gray-400 hover:text-gray-600"
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        placeholder="Type and press Enter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addValue();
          }
        }}
        className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-[12px] focus:border-gray-400 focus:outline-none"
      />
    </div>
  );
}

// -- Property Card (unified view/edit) --

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  extraction: "Pipeline",
  user_edit: "User",
  retrieval: "Retrieval",
  input_mapping: "Input Mapping",
};

const ALL_EVIDENCE_TYPES = ["extraction", "user_edit", "retrieval", "input_mapping"] as const;

type PropertyFormData = {
  name: string;
  description: string;
  valueType: string;
  evaluationStrategy: string;
  enumValues: string[] | null;
  writableBy: string[] | null;
};

function PropertyCard({
  property,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onDragStart,
  onDragEnd,
  isDragging,
  isLoading,
}: {
  property?: SummaryPropertyType;
  isEditing: boolean;
  onEdit?: () => void;
  onSave: (data: PropertyFormData) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
  isLoading: boolean;
}) {
  const [name, setName] = useState(property?.name ?? "");
  const [description, setDescription] = useState(property?.description ?? "");
  const [valueType, setValueType] = useState(property?.value_type ?? "text");
  const [evaluationStrategy, setEvaluationStrategy] = useState(
    property?.evaluation_strategy ?? "latest",
  );
  const [enumValues, setEnumValues] = useState<string[]>(
    property?.enum_values ?? [],
  );
  const [writableBy, setWritableBy] = useState<string[] | null>(
    property?.writable_by ?? null,
  );

  useEffect(() => {
    if (isEditing) {
      setName(property?.name ?? "");
      setDescription(property?.description ?? "");
      setValueType(property?.value_type ?? "text");
      setEvaluationStrategy(property?.evaluation_strategy ?? "latest");
      setEnumValues(property?.enum_values ?? []);
      setWritableBy(property?.writable_by ?? null);
    }
  }, [isEditing]);

  const fieldLabel = "text-[11px] font-medium text-gray-500";
  const inputClass =
    "w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] focus:border-gray-400 focus:outline-none";

  // --- View mode ---
  if (!isEditing && property) {
    return (
      <div
        className={`group cursor-pointer rounded-lg border border-gray-100 px-3 py-2.5 transition-all hover:border-gray-200 hover:shadow-sm ${isDragging ? "opacity-40" : ""}`}
        onClick={onEdit}
      >
        <div className="mb-1 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {onDragStart && (
              <span
                draggable
                onDragStart={(e) => { e.stopPropagation(); onDragStart(); }}
                onDragEnd={(e) => { e.stopPropagation(); onDragEnd?.(); }}
                onClick={(e) => e.stopPropagation()}
                className="-ml-1 shrink-0 cursor-grab text-gray-300 opacity-0 transition-all hover:text-gray-500 active:cursor-grabbing group-hover:opacity-100"
                title="Drag to reorder"
                aria-label="Drag to reorder"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                  <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                  <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                </svg>
              </span>
            )}
            <p className="truncate text-[13px] font-semibold text-gray-900">
              {property.name}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100">
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="rounded p-0.5 text-gray-300 hover:text-red-500"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {property.description && (
          <p className="mb-2 text-[11px] leading-snug text-gray-400">
            {property.description}
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
          <span>
            <span className="text-gray-400">Type</span>{" "}
            <span className="text-gray-600">{property.value_type}</span>
          </span>
          <span>
            <span className="text-gray-400">Strategy</span>{" "}
            <span className="text-gray-600">
              {property.evaluation_strategy}
            </span>
          </span>
          {property.enum_values && property.enum_values.length > 0 && (
            <span>
              <span className="text-gray-400">Enum</span>{" "}
              <span className="text-gray-600">
                {property.enum_values.join(", ")}
              </span>
            </span>
          )}
          {property.writable_by && (
            <span>
              <span className="text-gray-400">Writable by</span>{" "}
              <span className="text-gray-600">
                {property.writable_by.map((t) => EVIDENCE_TYPE_LABELS[t] ?? t).join(", ")}
              </span>
            </span>
          )}
        </div>
      </div>
    );
  }

  // --- Edit mode ---
  return (
    <div className="rounded-lg border border-primary/20 bg-gray-50/50 px-3 py-3">
      <div className="space-y-3">
        <div>
          <label className={`mb-1 block ${fieldLabel}`}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            autoFocus
          />
        </div>
        <div>
          <label className={`mb-1 block ${fieldLabel}`}>Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <label className={fieldLabel}>Type</label>
          <Select
            value={valueType}
            onChange={(v) => {
              setValueType(v);
              if (v !== "text") setEnumValues([]);
            }}
            size="sm"
            options={[
              { label: "text", value: "text" },
              { label: "number", value: "number" },
              { label: "date", value: "date" },
              { label: "boolean", value: "boolean" },
              { label: "json", value: "json" },
            ]}
          />
          <label className={fieldLabel}>Strategy</label>
          <Select
            value={evaluationStrategy}
            onChange={setEvaluationStrategy}
            size="sm"
            options={[
              { label: "latest", value: "latest" },
              { label: "llm", value: "llm" },
            ]}
          />
        </div>

        {valueType === "text" && (
          <EnumValuesInput values={enumValues} onChange={setEnumValues} />
        )}

        <div>
          <div className="mb-1 flex items-center gap-2">
            <label className={fieldLabel}>Writable By</label>
            <label className="flex items-center gap-1 text-[10px] text-gray-400">
              <input
                type="checkbox"
                checked={writableBy === null}
                onChange={(e) => setWritableBy(e.target.checked ? null : [...ALL_EVIDENCE_TYPES])}
                className="h-3 w-3 rounded border-gray-300"
              />
              all
            </label>
          </div>
          {writableBy !== null && (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {ALL_EVIDENCE_TYPES.map((et) => (
                <label key={et} className="flex items-center gap-1 text-[11px] text-gray-600">
                  <input
                    type="checkbox"
                    checked={writableBy.includes(et)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setWritableBy([...writableBy, et]);
                      } else {
                        setWritableBy(writableBy.filter((t) => t !== et));
                      }
                    }}
                    className="h-3 w-3 rounded border-gray-300"
                  />
                  {EVIDENCE_TYPE_LABELS[et] ?? et}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() =>
            onSave({
              name,
              description,
              valueType,
              evaluationStrategy,
              enumValues: enumValues.length > 0 ? enumValues : null,
              writableBy,
            })
          }
          disabled={!name.trim() || isLoading}
          className="flex-1 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-40"
        >
          {isLoading ? "..." : property ? "Save" : "Add"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-[12px] text-gray-500 transition-colors hover:bg-gray-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// -- Uniqueness Constraints Section --

function UniquenessConstraintsSection({
  constraints,
  properties,
  outgoingEdges,
  incomingEdges,
  nodeTypeId,
  nodeTypeMap,
  onSave,
}: {
  constraints: ConstraintEntry[][] | null;
  properties: SummaryPropertyType[];
  outgoingEdges: SummaryEdgeType[];
  incomingEdges: SummaryEdgeType[];
  nodeTypeId: string;
  nodeTypeMap: Map<string, string>;
  onSave: (constraints: ConstraintEntry[][] | null) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [errors, setErrors] = useState<(string | null)[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const propertyMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const pt of properties) m.set(pt.id, pt.name);
    return m;
  }, [properties]);

  // name (lowercase) → property type ID
  const propertyByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const pt of properties) m.set(pt.name.toLowerCase(), pt.id);
    return m;
  }, [properties]);

  // Map edge type ID → other node type name (for serialization)
  const edgeMap = useMemo(() => {
    const m = new Map<string, { otherNodeTypeName: string }>();
    for (const et of outgoingEdges) {
      m.set(et.id, { otherNodeTypeName: nodeTypeMap.get(et.target_node_type_id) ?? "?" });
    }
    for (const et of incomingEdges) {
      if (!m.has(et.id)) {
        m.set(et.id, { otherNodeTypeName: nodeTypeMap.get(et.source_node_type_id) ?? "?" });
      }
    }
    return m;
  }, [outgoingEdges, incomingEdges, nodeTypeMap]);

  // node type name (lowercase) → edge lookup (for parsing)
  const edgeByNodeTypeName = useMemo(() => {
    const m = new Map<string, EdgeLookup>();
    for (const et of outgoingEdges) {
      const name = nodeTypeMap.get(et.target_node_type_id);
      if (name) m.set(name.toLowerCase(), { id: et.id, direction: "outgoing", otherNodeTypeName: name });
    }
    for (const et of incomingEdges) {
      if (et.source_node_type_id === nodeTypeId) continue;
      const name = nodeTypeMap.get(et.source_node_type_id);
      if (name && !m.has(name.toLowerCase())) {
        m.set(name.toLowerCase(), { id: et.id, direction: "incoming", otherNodeTypeName: name });
      }
    }
    return m;
  }, [outgoingEdges, incomingEdges, nodeTypeId, nodeTypeMap]);

  const startEditing = () => {
    const cs = constraints ?? [];
    setDrafts(cs.map((c) => serializeConstraint(c, propertyMap, edgeMap)));
    setErrors(cs.map(() => null));
    setIsEditing(true);
  };

  const handleSave = async () => {
    const parsed: ConstraintEntry[][] = [];
    const newErrors: (string | null)[] = [];
    let hasError = false;

    for (const text of drafts) {
      if (!text.trim()) {
        newErrors.push(null);
        continue;
      }
      const result = parseConstraintText(text, propertyByName, edgeByNodeTypeName);
      if (result.ok) {
        parsed.push(result.entries);
        newErrors.push(null);
      } else {
        newErrors.push(result.error);
        hasError = true;
      }
    }

    setErrors(newErrors);
    if (hasError) return;

    setIsSaving(true);
    try {
      await onSave(parsed.length > 0 ? parsed : null);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  const updateDraft = (idx: number, value: string) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? value : d)));
    setErrors((prev) => prev.map((e, i) => (i === idx ? null : e)));
  };

  const removeDraft = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
    setErrors((prev) => prev.filter((_, i) => i !== idx));
  };

  const addDraft = () => {
    setDrafts((prev) => [...prev, ""]);
    setErrors((prev) => [...prev, null]);
  };

  const hasConstraints = constraints && constraints.length > 0;

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
          Uniqueness
        </span>
        {!isEditing && (
          <button
            onClick={startEditing}
            className="text-[11px] text-gray-500 transition-colors hover:text-gray-700"
          >
            {hasConstraints ? "Edit" : "+ Add"}
          </button>
        )}
      </div>

      {isEditing ? (
        <div className="rounded-lg border border-primary/20 bg-gray-50/50 px-3 py-3">
          {drafts.length === 0 && (
            <p className="mb-2 text-[11px] text-gray-400">
              No constraints — every extraction creates a new node.
            </p>
          )}
          <div className="space-y-2">
            {drafts.map((text, ci) => (
              <div key={ci}>
                {ci > 0 && (
                  <div className="flex justify-center py-0.5">
                    <span className="text-[9px] font-medium text-gray-400">OR</span>
                  </div>
                )}
                <div className="flex items-start gap-1.5">
                  <ConstraintInput
                    value={text}
                    onChange={(v) => updateDraft(ci, v)}
                    onCommit={handleSave}
                    onCancel={() => setIsEditing(false)}
                    propertyNames={Array.from(propertyMap.values())}
                    edgeNodeTypeNames={Array.from(
                      new Set(
                        Array.from(edgeByNodeTypeName.values()).map(
                          (e) => e.otherNodeTypeName,
                        ),
                      ),
                    )}
                    error={errors[ci]}
                    autoFocus={ci === drafts.length - 1}
                    placeholder="e.g. FUZZY(Name) AND -[:Organisation]->"
                  />
                  <button
                    onClick={() => removeDraft(ci)}
                    className="mt-1.5 shrink-0 text-gray-300 hover:text-red-500"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                {errors[ci] && (
                  <p className="mt-0.5 text-[10px] text-red-500">{errors[ci]}</p>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={addDraft}
            className="mt-2 text-[11px] text-gray-500 transition-colors hover:text-gray-700"
          >
            + Add alternative
          </button>
          <p className="mt-1.5 text-[10px] text-gray-400">
            Properties by name, edges as{" "}
            <code className="rounded bg-gray-100 px-1 text-[9px]">{"-[:Type]->"}</code>.
            Wrap in <code className="rounded bg-gray-100 px-1 text-[9px]">FUZZY()</code> for
            similarity matching. Join with <code className="rounded bg-gray-100 px-1 text-[9px]">AND</code>.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex-1 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-40"
            >
              {isSaving ? "..." : "Save"}
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="rounded-md px-3 py-1.5 text-[12px] text-gray-500 transition-colors hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : hasConstraints ? (
        <div
          className="cursor-pointer space-y-1 rounded-lg border border-gray-100 px-3 py-2.5 transition-all hover:border-gray-200 hover:shadow-sm"
          onClick={startEditing}
        >
          {constraints!.map((constraint, ci) => (
            <div key={ci}>
              {ci > 0 && (
                <div className="flex justify-center py-0.5">
                  <span className="text-[9px] font-medium text-gray-400">OR</span>
                </div>
              )}
              <p className="font-mono text-[11px] text-gray-700">
                {serializeConstraint(constraint, propertyMap, edgeMap)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p
          className="cursor-pointer text-[12px] text-gray-400 hover:text-primary-600"
          onClick={startEditing}
        >
          No constraints — click to add...
        </p>
      )}
    </div>
  );
}

// -- Display Name Formula Editor --

function DisplayNameFormulaEditor({
  expression,
  properties,
  outgoingEdges,
  nodeTypeId,
  allNodeTypes,
  allEdgeTypes,
  allPropertyTypes,
  onSave,
}: {
  expression: Expression | null;
  properties: SummaryPropertyType[];
  outgoingEdges: SummaryEdgeType[];
  nodeTypeId: string;
  allNodeTypes: SummaryNodeType[];
  allEdgeTypes: SummaryEdgeType[];
  allPropertyTypes: SummaryPropertyType[];
  onSave: (expr: Expression | null) => Promise<void>;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build resolver maps: ID → name for serialization, name → ID for parsing
  const propertyInfos = useMemo((): PropertyInfo[] => {
    return allPropertyTypes
      .filter((pt) => pt.node_type_id != null)
      .map((pt) => ({
        id: pt.id,
        name: pt.name,
        nodeTypeId: pt.node_type_id!,
        valueType: pt.value_type,
        enumValues: pt.enum_values ?? undefined,
      }));
  }, [allPropertyTypes]);

  const edgeInfos = useMemo((): EdgeInfo[] => {
    return allEdgeTypes.map((et) => ({
      id: et.id,
      outboundName: et.outbound_name,
      inboundName: et.inbound_name,
      sourceNodeTypeId: et.source_node_type_id,
      targetNodeTypeId: et.target_node_type_id,
    }));
  }, [allEdgeTypes]);

  const idToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of allPropertyTypes) m.set(p.id, p.name);
    for (const e of allEdgeTypes) m.set(e.id, e.outbound_name);
    return m;
  }, [allPropertyTypes, allEdgeTypes]);

  const resolveId = useCallback(
    (id: string, isEdge?: boolean) => idToName.get(id) ?? id,
    [idToName],
  );

  const resolveProperty = useCallback(
    (name: string) => {
      const pt = properties.find((p) => p.name === name);
      return pt?.id;
    },
    [properties],
  );

  const resolveEdge = useCallback(
    (name: string) => {
      const et = outgoingEdges.find((e) => e.outbound_name === name);
      return et?.id;
    },
    [outgoingEdges],
  );

  const resolveEdgeWithDirection = useCallback(
    (name: string) => {
      const et = outgoingEdges.find((e) => e.outbound_name === name);
      if (et) return { id: et.id, direction: 'outgoing' as const };
      return undefined;
    },
    [outgoingEdges],
  );

  // Formula text state
  const [text, setText] = useState(() =>
    expression ? formulaSerialize(expression, resolveId) : '',
  );
  const [validation, setValidation] = useState<FormulaValidation>({ valid: true });
  const [inputFocused, setInputFocused] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; direction: 'up' | 'down' } | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const suppressCloseRef = useRef(false);

  // Re-serialize when expression changes externally
  const lastExprRef = useRef(expression);
  useEffect(() => {
    if (expression !== lastExprRef.current) {
      lastExprRef.current = expression;
      setText(expression ? formulaSerialize(expression, resolveId) : '');
      setValidation({ valid: true, expression: expression ?? undefined });
    }
  }, [expression, resolveId]);

  const handleTextChange = useCallback((newText: string, newCursorPos?: number) => {
    setText(newText);
    setCursorPos(newCursorPos ?? newText.length);
    if (!newText.trim()) {
      setValidation({ valid: true });
      onSave(null);
      lastExprRef.current = null;
      return;
    }
    const result = formulaValidate(
      newText, resolveProperty, undefined, resolveEdge,
      undefined, resolveEdgeWithDirection, undefined,
      propertyInfos, edgeInfos, nodeTypeId,
    );
    setValidation(result);
    if (result.valid && result.expression) {
      lastExprRef.current = result.expression;
      onSave(result.expression);
    }
  }, [onSave, resolveProperty, resolveEdge, resolveEdgeWithDirection, propertyInfos, edgeInfos, nodeTypeId]);

  // Autocomplete
  const completions = useMemo(() => {
    return formulaCompletions(text, cursorPos, propertyInfos, edgeInfos, nodeTypeId);
  }, [text, cursorPos, propertyInfos, edgeInfos, nodeTypeId]);

  const dropdownOpen = inputFocused && completions.length > 0;

  useLayoutEffect(() => {
    if (!dropdownOpen || !inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const maxH = 260;
    const direction = spaceBelow < maxH && rect.top > spaceBelow ? 'up' : 'down';
    setDropdownPos({
      top: direction === 'down' ? rect.bottom + 2 : rect.top - 2,
      left: Math.min(rect.left, window.innerWidth - 220),
      direction,
    });
  }, [dropdownOpen, completions.length, text]);

  useEffect(() => { setFocusIdx(0); }, [text]);

  useEffect(() => {
    if (!inputFocused) return;
    const handleClick = (e: MouseEvent) => {
      if (suppressCloseRef.current) return;
      if (listRef.current?.contains(e.target as Node)) return;
      if (inputRef.current?.contains(e.target as Node)) return;
      setInputFocused(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [inputFocused]);

  const applyCompletion = useCallback((c: FormulaCompletion) => {
    // Find the start of the current token to replace
    let replaceStart = cursorPos;
    const before = text.slice(0, cursorPos);
    if (c.kind === 'edge' && (c.insert.startsWith('-[:') || c.insert.startsWith('<-[:'))) {
      // Edge completions: consume partial traversal syntax like -[, -[:, <-[:
      const partialMatch = before.match(/<?-\[(?::.*)?$/);
      if (partialMatch) {
        replaceStart = cursorPos - partialMatch[0].length;
      }
    } else if (c.kind === 'special' && c.insert.startsWith('@')) {
      // Special completions: consume partial @ prefix
      const atMatch = before.match(/@[a-zA-Z0-9_.]*$/);
      if (atMatch) {
        replaceStart = cursorPos - atMatch[0].length;
      }
    } else {
      while (replaceStart > 0 && /[a-zA-Z0-9_`]/.test(text[replaceStart - 1])) {
        replaceStart--;
      }
    }
    const beforeText = text.slice(0, replaceStart);
    const after = text.slice(cursorPos);
    const newText = beforeText + c.insert + after;
    const newCursor = beforeText.length + c.insert.length;
    pendingCursorRef.current = newCursor;
    suppressCloseRef.current = true;
    setInputFocused(true);
    handleTextChange(newText, newCursor);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCursor, newCursor);
      pendingCursorRef.current = null;
      suppressCloseRef.current = false;
    });
  }, [text, cursorPos, handleTextChange]);

  return (
    <div>
      <div className="relative">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onFocus={() => setInputFocused(true)}
          onSelect={() => {
            if (pendingCursorRef.current != null) return;
            setCursorPos(inputRef.current?.selectionStart ?? text.length);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setInputFocused(false); inputRef.current?.blur(); }
            else if (e.key === 'ArrowDown' && dropdownOpen) {
              e.preventDefault();
              setFocusIdx((i) => Math.min(i + 1, completions.length - 1));
            }
            else if (e.key === 'ArrowUp' && dropdownOpen) {
              e.preventDefault();
              setFocusIdx((i) => Math.max(i - 1, 0));
            }
            else if ((e.key === 'Enter' || e.key === 'Tab') && dropdownOpen && completions[focusIdx]) {
              e.preventDefault();
              applyCompletion(completions[focusIdx]);
            }
            else if (e.key === 'Enter' && !dropdownOpen) {
              e.preventDefault();
            }
          }}
          placeholder='e.g. CONCAT(-[:Deal For]->.Name, " — ", `Round Type`)'
          className="w-full resize-none overflow-hidden rounded-md border border-gray-200 bg-white px-2.5 py-1.5 pr-8 font-mono text-[12px] focus:border-gray-400 focus:outline-none"
          style={{ fieldSizing: 'content' } as React.CSSProperties}
          spellCheck={false}
          autoComplete="off"
        />
        {text.trim() && validation.valid && (
          <svg className="absolute right-2 top-2 h-3.5 w-3.5 text-green-500" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
          </svg>
        )}
      </div>
      {text.trim() && !validation.valid && !dropdownOpen && (
        <div className="mt-1 text-[11px] text-red-400">{validation.error}</div>
      )}
      {dropdownOpen && completions.length > 0 && dropdownPos && createPortal(
        <div
          ref={listRef}
          onMouseDown={(e) => e.preventDefault()}
          className="fixed z-[9999] min-w-[200px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
          style={dropdownPos.direction === 'down'
            ? { top: dropdownPos.top, left: dropdownPos.left }
            : { bottom: window.innerHeight - dropdownPos.top, left: dropdownPos.left }
          }
        >
          <div className="max-h-52 overflow-auto py-1">
            {completions.map((c, i) => (
              <button
                key={c.insert + i}
                type="button"
                ref={(el) => { if (i === focusIdx && el) el.scrollIntoView({ block: 'nearest' }); }}
                onMouseEnter={() => setFocusIdx(i)}
                onMouseDown={() => applyCompletion(c)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                  i === focusIdx ? 'bg-gray-100 text-gray-900' : 'text-gray-700'
                }`}
              >
                <span className={`rounded px-1 py-0.5 font-mono text-[10px] ${
                  c.kind === 'value' ? 'bg-blue-50 text-blue-600' :
                  c.kind === 'edge' ? 'bg-green-50 text-green-600' :
                  c.kind === 'function' ? 'bg-purple-50 text-purple-600' :
                  c.kind === 'keyword' ? 'bg-purple-50 text-purple-600' :
                  'bg-gray-50 text-gray-500'
                }`}>
                  {c.kind === 'value' ? 'prop' :
                   c.kind === 'edge' ? 'edge' :
                   c.kind === 'function' || c.kind === 'keyword' ? 'fn' : c.kind}
                </span>
                <span className="truncate">{c.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// -- Node Detail Panel --

export function NodeDetailPanel({
  nodeTypeId,
  allNodeTypes,
  allEdgeTypes,
  allPropertyTypes,
  onClose,
  onNavigateToNode,
}: {
  nodeTypeId: string;
  allNodeTypes: SummaryNodeType[];
  allEdgeTypes: SummaryEdgeType[];
  allPropertyTypes: SummaryPropertyType[];
  onClose: () => void;
  onNavigateToNode: (nodeId: string) => void;
}) {
  const nodeType = allNodeTypes.find((nt) => nt.id === nodeTypeId);
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(
    null,
  );
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [descriptionValue, setDescriptionValue] = useState("");
  const [templateValue, setTemplateValue] = useState("");
  const templateInputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const { mutateAsync: createPropertyType, isLoading: isCreating } =
    trpc.views.knowledge.ontology.createPropertyType.useMutation();
  const { mutateAsync: updatePropertyType, isLoading: isUpdating } =
    trpc.views.knowledge.ontology.updatePropertyType.useMutation();
  const { mutateAsync: deletePropertyType } =
    trpc.views.knowledge.ontology.deletePropertyType.useMutation();
  const { mutateAsync: updateNodeType } =
    trpc.views.knowledge.ontology.updateNodeType.useMutation();
  const { mutateAsync: reorderPropertyTypes } =
    trpc.views.knowledge.ontology.reorderPropertyTypes.useMutation();

  useEffect(() => {
    setShowAddProperty(false);
    setEditingPropertyId(null);
    setEditingName(false);
    setEditingDescription(false);
    setEditingTemplate(false);
  }, [nodeTypeId]);

  const properties = useMemo(
    () => allPropertyTypes.filter((pt) => pt.node_type_id === nodeTypeId),
    [allPropertyTypes, nodeTypeId],
  );

  const outgoingEdges = useMemo(
    () => allEdgeTypes.filter((et) => et.source_node_type_id === nodeTypeId),
    [allEdgeTypes, nodeTypeId],
  );

  const incomingEdges = useMemo(
    () => allEdgeTypes.filter((et) => et.target_node_type_id === nodeTypeId),
    [allEdgeTypes, nodeTypeId],
  );

  const nodeTypeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const nt of allNodeTypes) m.set(nt.id, nt.name);
    return m;
  }, [allNodeTypes]);

  if (!nodeType) return null;

  const badgeClass = CATEGORY_BADGE[nodeType.category] ?? CATEGORY_BADGE.object;

  const handleCreateProperty = async (data: PropertyFormData) => {
    await createPropertyType({
      nodeTypeId,
      name: data.name,
      description: data.description,
      valueType: data.valueType as PropertyValueType,
      evaluationStrategy: data.evaluationStrategy as EvaluationStrategy,
      enumValues: data.enumValues,
      writableBy: data.writableBy as EvidenceType[] | null,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    setShowAddProperty(false);
  };

  const handleUpdateProperty = async (id: string, data: PropertyFormData) => {
    await updatePropertyType({
      id,
      name: data.name,
      description: data.description,
      valueType: data.valueType as PropertyValueType,
      evaluationStrategy: data.evaluationStrategy as EvaluationStrategy,
      enumValues: data.enumValues,
      writableBy: data.writableBy as EvidenceType[] | null,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    setEditingPropertyId(null);
  };

  const handleDeleteProperty = async (id: string) => {
    await deletePropertyType({ id });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
  };

  // Drag-to-reorder (native HTML5 DnD — no dependency for a short list).
  // `dragIndex` is the row being dragged; `overIndex` is where it would
  // drop. On drop we splice and persist via the same reorder mutation the
  // old up/down buttons used.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const commitReorder = async (from: number, to: number) => {
    if (from === to) return;
    const reordered = [...properties];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    await reorderPropertyTypes({ ids: reordered.map((p) => p.id) });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
  };

  const handleSaveName = async () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== nodeType.name) {
      await updateNodeType({ id: nodeTypeId, name: trimmed });
      utils.views.knowledge.ontology.getOntologySummary.invalidate();
    }
    setEditingName(false);
  };

  const handleSaveDescription = async () => {
    if (descriptionValue !== (nodeType.description ?? "")) {
      await updateNodeType({ id: nodeTypeId, description: descriptionValue });
      utils.views.knowledge.ontology.getOntologySummary.invalidate();
    }
    setEditingDescription(false);
  };

  const handleSaveTemplate = async () => {
    const value = templateValue.trim() || null;
    if (value !== (nodeType.display_name_template ?? null)) {
      await updateNodeType({ id: nodeTypeId, displayNameTemplate: value });
      utils.views.knowledge.ontology.getOntologySummary.invalidate();
    }
    setEditingTemplate(false);
  };

  const insertToken = useCallback(
    (token: string) => {
      const input = templateInputRef.current;
      if (!input) return;
      const start = input.selectionStart ?? templateValue.length;
      const end = input.selectionEnd ?? start;
      const inserted = `{${token}}`;
      const next = templateValue.slice(0, start) + inserted + templateValue.slice(end);
      setTemplateValue(next);
      requestAnimationFrame(() => {
        input.focus();
        const cursor = start + inserted.length;
        input.setSelectionRange(cursor, cursor);
      });
    },
    [templateValue],
  );

  // Available tokens: property names + outgoing edge names for this node type
  const templateTokens = useMemo(() => {
    const tokens: string[] = [];
    for (const pt of properties) tokens.push(pt.name);
    for (const et of outgoingEdges) tokens.push(et.outbound_name);
    return tokens;
  }, [properties, outgoingEdges]);

  // Display name expression mode: true = expression, false = template
  const [displayNameMode, setDisplayNameMode] = useState<'template' | 'expression'>(
    () => nodeType?.display_name_expression ? 'expression' : 'template',
  );

  useEffect(() => {
    setDisplayNameMode(nodeType?.display_name_expression ? 'expression' : 'template');
  }, [nodeTypeId]);

  return (
    <div className="p-4">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div className="flex-1 min-w-0">
          {editingName ? (
            <input
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveName();
                if (e.key === "Escape") setEditingName(false);
              }}
              autoFocus
              className="w-full rounded border border-gray-300 px-1.5 py-0.5 text-[15px] font-semibold text-gray-900 focus:border-gray-400 focus:outline-none"
            />
          ) : (
            <h2
              className="cursor-pointer text-[15px] font-semibold text-gray-900 hover:text-primary-600"
              onClick={() => {
                setNameValue(nodeType.name);
                setEditingName(true);
              }}
            >
              {nodeType.name}
            </h2>
          )}
          <span
            className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeClass}`}
          >
            {CATEGORY_LABEL[nodeType.category] ?? nodeType.category}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {editingDescription ? (
        <textarea
          value={descriptionValue}
          onChange={(e) => setDescriptionValue(e.target.value)}
          onBlur={handleSaveDescription}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditingDescription(false);
          }}
          autoFocus
          rows={2}
          className="mb-4 w-full rounded border border-gray-300 px-2 py-1 text-[12px] text-gray-500 focus:border-gray-400 focus:outline-none"
        />
      ) : (
        <p
          className="mb-4 cursor-pointer text-[12px] text-gray-500 hover:text-primary-600"
          onClick={() => {
            setDescriptionValue(nodeType.description ?? "");
            setEditingDescription(true);
          }}
        >
          {nodeType.description || "Click to add description..."}
        </p>
      )}

      {/* Display Name */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Display Name
          </span>
          <div className="flex rounded-md border border-gray-200 text-[10px]">
            <button
              type="button"
              onClick={() => setDisplayNameMode('template')}
              className={`px-2 py-0.5 ${displayNameMode === 'template' ? 'bg-gray-100 font-medium text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}
            >
              Simple
            </button>
            <button
              type="button"
              onClick={() => setDisplayNameMode('expression')}
              className={`px-2 py-0.5 ${displayNameMode === 'expression' ? 'bg-gray-100 font-medium text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}
            >
              Expression
            </button>
          </div>
        </div>
        {displayNameMode === 'template' ? (
          editingTemplate ? (
            <div>
              <input
                ref={templateInputRef}
                type="text"
                value={templateValue}
                onChange={(e) => setTemplateValue(e.target.value)}
                onBlur={handleSaveTemplate}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveTemplate();
                  if (e.key === "Escape") setEditingTemplate(false);
                }}
                placeholder="e.g. {Name} — {Round Type}"
                autoFocus
                className="mb-1.5 w-full rounded border border-gray-300 px-2 py-1 text-[12px] text-gray-700 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
              />
              {templateTokens.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {templateTokens.map((token) => (
                    <button
                      key={token}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertToken(token);
                      }}
                      className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 transition-colors hover:bg-blue-100 hover:text-blue-700"
                    >
                      {`{${token}}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p
              className="cursor-pointer text-[12px] text-gray-500 hover:text-primary-600"
              onClick={() => {
                setTemplateValue(nodeType.display_name_template ?? "");
                setEditingTemplate(true);
              }}
            >
              {nodeType.display_name_template || "Click to set template..."}
            </p>
          )
        ) : (
          <DisplayNameFormulaEditor
            expression={nodeType.display_name_expression as Expression | null}
            properties={properties}
            outgoingEdges={outgoingEdges}
            nodeTypeId={nodeTypeId}
            allNodeTypes={allNodeTypes}
            allEdgeTypes={allEdgeTypes}
            allPropertyTypes={allPropertyTypes}
            onSave={async (expr) => {
              await updateNodeType({ id: nodeTypeId, displayNameExpression: expr });
              utils.views.knowledge.ontology.getOntologySummary.invalidate();
            }}
          />
        )}
      </div>

      {/* Uniqueness Constraints */}
      {nodeType.category !== "message" && nodeType.category !== "property" && (
        <UniquenessConstraintsSection
          constraints={nodeType.uniqueness_constraints as ConstraintEntry[][] | null}
          properties={properties}
          outgoingEdges={outgoingEdges}
          incomingEdges={incomingEdges}
          nodeTypeId={nodeTypeId}
          nodeTypeMap={nodeTypeMap}
          onSave={async (constraints) => {
            await updateNodeType({
              id: nodeTypeId,
              uniquenessConstraints: constraints,
            });
            utils.views.knowledge.ontology.getOntologySummary.invalidate();
          }}
        />
      )}

      {/* Properties */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Properties ({properties.length})
          </span>
          {!showAddProperty && (
            <button
              onClick={() => setShowAddProperty(true)}
              className="text-[11px] text-gray-500 transition-colors hover:text-gray-700"
            >
              + Add
            </button>
          )}
        </div>

        <div className="space-y-1.5">
          {properties.map((pt, i) => (
            <div
              key={pt.id}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                if (overIndex !== i) setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) void commitReorder(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={
                dragIndex !== null && overIndex === i && dragIndex !== i
                  ? "rounded-lg ring-2 ring-primary/40"
                  : undefined
              }
            >
              <PropertyCard
                property={pt}
                isEditing={editingPropertyId === pt.id}
                onEdit={() => setEditingPropertyId(pt.id)}
                onSave={(data) => handleUpdateProperty(pt.id, data)}
                onCancel={() => setEditingPropertyId(null)}
                onDelete={() => handleDeleteProperty(pt.id)}
                onDragStart={() => { setDragIndex(i); setOverIndex(i); }}
                onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                isDragging={dragIndex === i}
                isLoading={isUpdating}
              />
            </div>
          ))}

          {showAddProperty && (
            <PropertyCard
              isEditing={true}
              onSave={handleCreateProperty}
              onCancel={() => setShowAddProperty(false)}
              isLoading={isCreating}
            />
          )}
        </div>
      </div>

      {/* Outgoing Edges */}
      {outgoingEdges.length > 0 && (
        <div className="mb-4">
          <span className="mb-2 block text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Outgoing Edges ({outgoingEdges.length})
          </span>
          {outgoingEdges.map((et) => (
            <div
              key={et.id}
              className="flex flex-wrap items-center gap-1.5 py-1 text-[12px]"
            >
              <span className="text-gray-500">
                {et.outbound_name.replace(/_/g, " ")}
              </span>
              <span className="text-gray-300">&rarr;</span>
              <button
                onClick={() => onNavigateToNode(et.target_node_type_id)}
                className="font-medium text-primary-600 hover:text-primary-700 hover:underline"
              >
                {nodeTypeMap.get(et.target_node_type_id) ?? "?"}
              </button>
              {et.scopes && (
                <span className="rounded bg-purple-50 px-1 py-0.5 text-[9px] font-medium text-purple-600">
                  scope
                </span>
              )}
              {et.required && (
                <span className="rounded bg-red-50 px-1 py-0.5 text-[9px] font-medium text-red-600">
                  req
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Incoming Edges */}
      {incomingEdges.length > 0 && (
        <div className="mb-4">
          <span className="mb-2 block text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Incoming Edges ({incomingEdges.length})
          </span>
          {incomingEdges.map((et) => (
            <div
              key={et.id}
              className="flex flex-wrap items-center gap-1.5 py-1 text-[12px]"
            >
              <button
                onClick={() => onNavigateToNode(et.source_node_type_id)}
                className="font-medium text-primary-600 hover:text-primary-700 hover:underline"
              >
                {nodeTypeMap.get(et.source_node_type_id) ?? "?"}
              </button>
              <span className="text-gray-300">&rarr;</span>
              <span className="text-gray-500">
                {et.inbound_name.replace(/_/g, " ")}
              </span>
              {et.scopes && (
                <span className="rounded bg-purple-50 px-1 py-0.5 text-[9px] font-medium text-purple-600">
                  scope
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ID */}
      <div className="border-t border-gray-100 pt-3">
        <p className="text-[10px] text-gray-400">ID: {nodeType.id}</p>
      </div>
    </div>
  );
}
