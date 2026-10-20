"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { trpc } from "@/lib/trpc";
import { NodeDetailDrawer } from "@/components/objects/node-detail-drawer";
import { Select, type SelectOption } from "@/components/select";
import { InlineSelect } from "@/components/inline-select";
import { ResizablePanel } from "@/components/resizable-panel";
import {
  TableFilterBar,
  type TableFilterBarHandle,
  type TableFilter,
  type FilterConjunction,
  type FilterItem,
  type FilterGroup,
  isFilterGroup,
} from "@/components/table-filters";
import {
  useTableUndoStore,
  type CellEdit,
} from "@/components/nodes-table-undo";
import { PanelDrawer } from "@/components/panel-drawer";
import { MobileBottomBar } from "@/components/mobile-bottom-bar";
import { useColumnWidths } from "@/lib/use-column-widths";
import { useIsMobile } from "@/lib/use-is-mobile";
import { TAB_ORIGIN_ID } from "@/lib/tab-origin";
import {
  Trash2,
  Pencil,
  Merge,
  X,
  PanelRight,
  Type,
  Hash,
  Calendar,
  ToggleLeft,
  List,
  Filter,
} from "lucide-react";

const PAGE_SIZE = 50;
const ROW_HEIGHT = 40;
const COL_WIDTH_CHECKBOX = 40;
const COL_WIDTH_FIRST = 240;
const COL_WIDTH = 168;
const COL_WIDTH_UPDATED = 120;
const COL_WIDTH_SCOPED = 180;

function ColumnTypeIcon({
  valueType,
  className,
}: {
  valueType: string;
  className?: string;
}) {
  const cn = className ?? "h-3 w-3 text-gray-400";
  switch (valueType) {
    case "number":
      return <Hash className={cn} />;
    case "date":
      return <Calendar className={cn} />;
    case "boolean":
      return <ToggleLeft className={cn} />;
    default:
      return <Type className={cn} />;
  }
}

type Column = {
  id: string;
  name: string;
  value_type: string;
  identity: string;
  enum_values: string[] | null;
};

type ScopingColumn = {
  edgeTypeId: string;
  edgeTypeName: string;
  targetNodeTypeName: string;
};

type Row = {
  id: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  values: Record<string, string | number | boolean | null>;
  scopingValues: Record<string, { parentName: string; parentNodeId: string }>;
  displayName: string | null;
};

function formatCellValue(
  value: string | number | boolean | null,
  valueType: string,
): string {
  if (value === null || value === undefined) return "";
  if (valueType === "boolean") return value ? "Yes" : "No";
  if (valueType === "date" && typeof value === "string") {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

function formatRelativeDate(date: string | Date): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type ApiFilterItem = {
  columnId: string;
  operator: string;
  value?: string | number | boolean | null;
  values?: string[];
  negated?: boolean;
  group?: { conjunction: "and" | "or"; filters: ApiFilterItem[] };
};

function serializeFilters(items: FilterItem[]): ApiFilterItem[] | undefined {
  if (items.length === 0) return undefined;
  return items.map((item): ApiFilterItem => {
    if (isFilterGroup(item)) {
      return {
        columnId: "",
        operator: "eq",
        group: {
          conjunction: item.conjunction,
          filters: item.filters.map((f) => ({
            columnId: f.columnId,
            operator: f.operator,
            value: f.value,
            values: f.values,
            negated: f.negated,
          })),
        },
      };
    }
    return {
      columnId: item.columnId,
      operator: item.operator,
      value: item.value,
      values: item.values,
      negated: item.negated,
    };
  });
}

function InlineEditCell({
  value,
  valueType,
  enumValues,
  colWidth,
  isFirst,
  isSelected,
  onSave,
  onCancel,
  onTab,
  onShiftTab,
  onEnterDown,
  className: extraClassName,
  style: extraStyle,
  children,
}: {
  value: string | number | boolean | null;
  valueType: string;
  enumValues: string[] | null;
  colWidth: number;
  isFirst: boolean;
  isSelected?: boolean;
  onSave: (rawValue: string) => void;
  onCancel: () => void;
  onTab?: () => void;
  onShiftTab?: () => void;
  onEnterDown?: () => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigatingRef = useRef(false);

  const initialValue = (() => {
    if (value === null || value === undefined) return "";
    if (valueType === "boolean") return String(value);
    if (valueType === "date" && typeof value === "string") {
      return new Date(value).toISOString().slice(0, 10);
    }
    return String(value);
  })();

  const cellClass = `flex items-center truncate text-[13px] ${
    isFirst ? "font-medium text-gray-900" : "text-gray-600"
  } ${isSelected ? "ring-2 ring-inset ring-primary" : ""}`;

  if (
    valueType === "boolean" ||
    (Array.isArray(enumValues) && enumValues.length > 0)
  ) {
    const options: SelectOption[] =
      valueType === "boolean"
        ? [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]
        : enumValues!.map((v) => ({ value: v, label: v }));

    return (
      <div
        style={{ width: colWidth, ...extraStyle }}
        className={cellClass + " px-3" + (extraClassName ? ` ${extraClassName}` : "")}
        onClick={(e) => e.stopPropagation()}
      >
        <InlineSelect
          value={initialValue}
          onChange={(v) => onSave(v)}
          options={options}
          autoOpen
          align="left"
          textSize="text-[13px]"
        />
        {children}
      </div>
    );
  }

  return (
    <div
      style={{ width: colWidth, ...extraStyle }}
      className={cellClass + " px-3" + (extraClassName ? ` ${extraClassName}` : "")}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type={
          valueType === "date"
            ? "date"
            : valueType === "number"
              ? "number"
              : "text"
        }
        defaultValue={initialValue}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        className="h-full w-full border-0 border-b border-b-primary/40 bg-transparent p-0 text-[13px] text-inherit outline-none"
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            navigatingRef.current = true;
            onSave(e.currentTarget.value);
            if (e.shiftKey) onShiftTab?.();
            else onTab?.();
          } else if (e.key === "Enter") {
            e.preventDefault();
            navigatingRef.current = true;
            onSave(e.currentTarget.value);
            onEnterDown?.();
          } else if (e.key === "Escape") {
            navigatingRef.current = true;
            onCancel();
          }
        }}
        onBlur={(e) => {
          if (!navigatingRef.current) {
            onSave(e.currentTarget.value);
          }
        }}
      />
      {children}
    </div>
  );
}

function CreateNodeDialog({
  nodeTypeId,
  columns,
  onCreated,
  onClose,
}: {
  nodeTypeId: string;
  columns: Column[];
  onCreated: () => void;
  onClose: () => void;
}) {
  const createNode = trpc.views.knowledge.graph.createNode.useMutation();
  const [values, setValues] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const properties = columns
      .filter((col) => values[col.id])
      .map((col) => {
        const val = values[col.id];
        return {
          propertyTypeId: col.id,
          ...(col.value_type === "boolean"
            ? { valueBoolean: val === "true" }
            : col.value_type === "number"
              ? { valueNumber: val }
              : col.value_type === "date"
                ? { valueDate: val }
                : { valueText: val }),
        };
      });

    await createNode.mutateAsync({ nodeTypeId, properties });
    onCreated();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="mx-4 w-full max-w-sm rounded-lg border border-gray-200 bg-white shadow-xl sm:mx-0 sm:w-96"
      >
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-gray-900">
            New Record
          </h2>
        </div>
        <div className="max-h-80 space-y-3 overflow-y-auto px-4 py-3">
          {columns.map((col) => (
            <div key={col.id}>
              <label className="mb-1 block text-[12px] font-medium text-gray-600">
                {col.name}
              </label>
              {col.value_type === "boolean" ? (
                <Select
                  value={values[col.id] ?? ""}
                  onChange={(v) =>
                    setValues((prev) => ({ ...prev, [col.id]: v }))
                  }
                  options={[
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                  placeholder="—"
                />
              ) : (
                <input
                  type={
                    col.value_type === "date"
                      ? "date"
                      : col.value_type === "number"
                        ? "number"
                        : "text"
                  }
                  value={values[col.id] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [col.id]: e.target.value }))
                  }
                  className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] placeholder:text-gray-400 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
                  placeholder={col.name}
                  autoFocus={
                    col.identity === "unique" || col.identity === "fuzzy"
                  }
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createNode.isLoading}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
          >
            {createNode.isLoading ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function BulkDeleteDialog({
  count,
  onConfirm,
  onClose,
  isLoading,
}: {
  count: number;
  onConfirm: () => void;
  onClose: () => void;
  isLoading: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-4 w-full max-w-sm rounded-lg border border-gray-200 bg-white shadow-xl sm:mx-0 sm:w-96"
      >
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-gray-900">
            Delete {count} record{count !== 1 ? "s" : ""}
          </h2>
        </div>
        <div className="px-4 py-3">
          <p className="text-[13px] text-gray-600">
            This will permanently delete {count} record{count !== 1 ? "s" : ""}{" "}
            and all their properties and relationships. This cannot be undone.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {isLoading ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkUpdateDialog({
  columns,
  count,
  onConfirm,
  onClose,
  isLoading,
}: {
  columns: Column[];
  count: number;
  onConfirm: (columnId: string, rawValue: string) => void;
  onClose: () => void;
  isLoading: boolean;
}) {
  const [selectedCol, setSelectedCol] = useState<string>(columns[0]?.id ?? "");
  const [value, setValue] = useState("");

  const col = columns.find((c) => c.id === selectedCol);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-4 w-full max-w-sm rounded-lg border border-gray-200 bg-white shadow-xl sm:mx-0 sm:w-96"
      >
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-gray-900">
            Update {count} record{count !== 1 ? "s" : ""}
          </h2>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              Property
            </label>
            <select
              value={selectedCol}
              onChange={(e) => {
                setSelectedCol(e.target.value);
                setValue("");
              }}
              className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              Value
            </label>
            {col?.value_type === "boolean" ? (
              <Select
                value={value}
                onChange={setValue}
                options={[
                  { value: "true", label: "Yes" },
                  { value: "false", label: "No" },
                ]}
                placeholder="—"
              />
            ) : Array.isArray(col?.enum_values) &&
              col.enum_values.length > 0 ? (
              <Select
                value={value}
                onChange={setValue}
                options={col.enum_values.map((v) => ({ value: v, label: v }))}
                placeholder="—"
              />
            ) : (
              <input
                type={
                  col?.value_type === "date"
                    ? "date"
                    : col?.value_type === "number"
                      ? "number"
                      : "text"
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] placeholder:text-gray-400 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
                placeholder="Enter value..."
                autoFocus
              />
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(selectedCol, value)}
            disabled={isLoading || !value}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
          >
            {isLoading ? "Updating..." : "Update"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkMergeDialog({
  selectedIds,
  rows,
  columns,
  onConfirm,
  onClose,
  isLoading,
  error,
}: {
  selectedIds: Set<string>;
  rows: Map<number, Row[]>;
  columns: Column[];
  onConfirm: (targetId: string) => void;
  onClose: () => void;
  isLoading: boolean;
  error: string | null;
}) {
  const selectedRows = useMemo(() => {
    const result: Row[] = [];
    for (const [, pageRows] of rows) {
      for (const row of pageRows) {
        if (selectedIds.has(row.id)) result.push(row);
      }
    }
    return result;
  }, [selectedIds, rows]);

  const [targetId, setTargetId] = useState(selectedRows[0]?.id ?? "");

  const identityCol = columns.find(
    (c) => c.identity === "unique" || c.identity === "fuzzy",
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-4 w-full max-w-sm rounded-lg border border-gray-200 bg-white shadow-xl sm:mx-0 sm:w-96"
      >
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-gray-900">
            Merge {selectedRows.length} records
          </h2>
        </div>
        <div className="px-4 py-3">
          <p className="mb-3 text-[13px] text-gray-600">
            Choose which record to keep. All others will be merged into it —
            their properties and relationships will be transferred, then they
            will be deleted.
          </p>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {selectedRows.map((row) => {
              const label = row.displayName
                ? row.displayName
                : identityCol
                  ? formatCellValue(
                      row.values[identityCol.id],
                      identityCol.value_type,
                    )
                  : row.id.slice(0, 8);
              return (
                <label
                  key={row.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                    targetId === row.id
                      ? "bg-primary/10 text-gray-900"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="merge-target"
                    value={row.id}
                    checked={targetId === row.id}
                    onChange={() => setTargetId(row.id)}
                    className="accent-primary"
                  />
                  <span className="truncate">
                    {label || row.id.slice(0, 8)}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(targetId)}
            disabled={isLoading || !targetId}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
          >
            {isLoading ? "Merging..." : "Merge"}
          </button>
        </div>
        {error && (
          <div className="border-t border-red-100 px-4 py-2">
            <p className="text-[11px] text-red-600">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export type NodesTableHandle = {
  openCreate: () => void;
};

export const NodesTable = forwardRef<
  NodesTableHandle,
  {
    nodeTypeId: string;
    ontology:
      | { nodeTypes: { id: string; name: string; icon_svg: string | null }[] }
      | undefined;
    showCreateButton?: boolean;
    filterId?: string | null;
    onFilterIdChange?: (filterId: string | null) => void;
  }
>(function NodesTable(
  { nodeTypeId, ontology, showCreateButton = true, filterId, onFilterIdChange },
  ref,
) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const isMobile = useIsMobile();

  // On touch, selecting a row means "show me this record" — there is no
  // side panel, so the detail drawer follows selection. An effect (not
  // the row onClick) because cell handlers stopPropagation and set the
  // selection themselves.
  useEffect(() => {
    if (isMobile && selectedNodeId) setRightOpen(true);
  }, [isMobile, selectedNodeId]);

  useImperativeHandle(ref, () => ({
    openCreate: () => setShowCreate(true),
  }));

  const [selectedCell, setSelectedCell] = useState<{
    rowId: string;
    colId: string;
  } | null>(null);
  const [editingCell, setEditingCell] = useState<{
    rowId: string;
    colId: string;
  } | null>(null);
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);
  const [showBulkMerge, setShowBulkMerge] = useState(false);
  const [filters, setFilters] = useState<FilterItem[]>([]);
  const [conjunction, setConjunction] = useState<FilterConjunction>("and");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const filterBarRef = useRef<TableFilterBarHandle>(null);

  // Cmd+F / Ctrl+F to start filtering
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        filterBarRef.current?.startBuilding();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Derive search from _search filters
  const searchFromFilters = useMemo(() => {
    const searchFilters = filters.filter(
      (f): f is TableFilter =>
        !isFilterGroup(f) && f.columnId === "_search" && !!f.value,
    );
    return searchFilters.map((f) => String(f.value)).join(" ") || undefined;
  }, [filters]);

  // Filter out _search items before sending to API
  const apiFilterItems = useMemo(
    () => filters.filter((f) => isFilterGroup(f) || f.columnId !== "_search"),
    [filters],
  );

  const utils = trpc.useUtils();
  const editProperty = trpc.views.knowledge.graph.createUserEdit.useMutation();
  const createProperty =
    trpc.views.knowledge.graph.createProperty.useMutation();
  const bulkDeleteNodes =
    trpc.views.knowledge.graph.bulkDeleteNodes.useMutation();
  const bulkUpdateProperty =
    trpc.views.knowledge.graph.bulkUpdateProperty.useMutation();
  const mergeNodesMutation =
    trpc.views.knowledge.graph.mergeNodes.useMutation();
  const parseNlFilter =
    trpc.views.knowledge.graph.parseNaturalLanguageFilter.useMutation();
  const saveFilterMutation =
    trpc.views.knowledge.graph.saveFilter.useMutation();
  const hydratingRef = useRef(false);

  // Load saved filter from URL param on mount
  const savedFilterQuery = trpc.views.knowledge.graph.getFilter.useQuery(
    { id: filterId! },
    { enabled: !!filterId },
  );

  // Hydrate filters from saved filter
  useEffect(() => {
    if (!savedFilterQuery.data) return;
    const sf = savedFilterQuery.data;
    hydratingRef.current = true;
    setFilters(
      sf.filters.map((f: any): FilterItem => {
        if (f.group) {
          return {
            id: crypto.randomUUID(),
            conjunction: f.group.conjunction as FilterConjunction,
            filters: f.group.filters.map((gf: any) => ({
              id: crypto.randomUUID(),
              columnId: gf.columnId,
              operator: gf.operator as TableFilter["operator"],
              value: gf.value,
              values: gf.values,
              negated: gf.negated,
            })),
          } as FilterGroup;
        }
        return {
          id: crypto.randomUUID(),
          columnId: f.columnId,
          operator: f.operator as TableFilter["operator"],
          value: f.value,
          values: f.values,
          negated: f.negated,
        };
      }),
    );
    setConjunction(sf.conjunction);
    // Reset table state for new filters
    setPages(new Map());
    setTotal(null);
    setPropertyIds(new Map());
    setSelectedIds(new Set());
    loadingPages.current.clear();
    syncedDataRef.current = null;
    // Allow saves again after a tick
    requestAnimationFrame(() => {
      hydratingRef.current = false;
    });
  }, [savedFilterQuery.data]);

  const [pages, setPages] = useState<Map<number, Row[]>>(new Map());
  const [total, setTotal] = useState<number | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [scopingColumns, setScopingColumns] = useState<ScopingColumn[]>([]);
  const [hasDisplayName, setHasDisplayName] = useState(false);
  const loadingPages = useRef(new Set<number>());
  const syncedDataRef = useRef<unknown>(null);

  // Columns available for filtering — includes _search pseudo-column
  const filterColumns = useMemo(
    () => [
      {
        id: "_search",
        name: "Search",
        value_type: "_search",
        identity: "none",
        enum_values: null,
      },
      ...columns,
    ],
    [columns],
  );

  const [propertyIds, setPropertyIds] = useState<
    Map<string, Map<string, string>>
  >(new Map());

  const loadPage = useCallback(
    async (pageIndex: number) => {
      if (loadingPages.current.has(pageIndex)) return;
      loadingPages.current.add(pageIndex);

      try {
        const apiFilters = serializeFilters(apiFilterItems);

        const result = await utils.views.knowledge.graph.getNodesTable.fetch({
          nodeTypeId,
          search: searchFromFilters || undefined,
          filters: apiFilters,
          filterConjunction: conjunction,
          sortBy,
          sortDirection,
          limit: PAGE_SIZE,
          offset: pageIndex * PAGE_SIZE,
        });

        setTotal(result.total);
        if (result.columns.length > 0) setColumns(result.columns);
        setScopingColumns(result.scopingColumns);
        setHasDisplayName(!!result.hasDisplayName);
        setPages((prev) => {
          const next = new Map(prev);
          next.set(pageIndex, result.rows as Row[]);
          return next;
        });
        if (result.propertyIds) {
          setPropertyIds((prev) => {
            const next = new Map(prev);
            for (const [nodeId, ptMap] of Object.entries(result.propertyIds)) {
              next.set(nodeId, new Map(Object.entries(ptMap)));
            }
            return next;
          });
        }
      } finally {
        loadingPages.current.delete(pageIndex);
      }
    },
    [
      nodeTypeId,
      searchFromFilters,
      sortBy,
      sortDirection,
      apiFilterItems,
      conjunction,
      utils,
    ],
  );

  const apiFiltersForQuery = serializeFilters(apiFilterItems);

  const initialQuery = trpc.views.knowledge.graph.getNodesTable.useQuery({
    nodeTypeId,
    search: searchFromFilters || undefined,
    filters: apiFiltersForQuery,
    filterConjunction: conjunction,
    sortBy,
    sortDirection,
    limit: PAGE_SIZE,
    offset: 0,
  });

  if (initialQuery.data && syncedDataRef.current !== initialQuery.data) {
    syncedDataRef.current = initialQuery.data;
    setTotal(initialQuery.data.total);
    if (initialQuery.data.columns.length > 0)
      setColumns(initialQuery.data.columns);
    setScopingColumns(initialQuery.data.scopingColumns);
    setHasDisplayName(!!initialQuery.data.hasDisplayName);
    setPages((prev) => {
      const next = new Map(prev);
      next.set(0, initialQuery.data.rows as Row[]);
      return next;
    });
    if (initialQuery.data.propertyIds) {
      setPropertyIds((prev) => {
        const next = new Map(prev);
        for (const [nodeId, ptMap] of Object.entries(
          initialQuery.data.propertyIds,
        )) {
          next.set(nodeId, new Map(Object.entries(ptMap)));
        }
        return next;
      });
    }
  }

  const handleParseNl = useCallback(
    async (query: string) => {
      const result = await parseNlFilter.mutateAsync({
        query,
        columns: columns.map((c) => ({
          id: c.id,
          name: c.name,
          value_type: c.value_type,
          enum_values: c.enum_values ?? null,
        })),
      });
      // API may return group wrappers — pass them through as-is
      return result as Array<
        Omit<TableFilter, "id"> & {
          group?: {
            conjunction: "and" | "or";
            filters: Omit<TableFilter, "id">[];
          };
        }
      >;
    },
    [columns, parseNlFilter],
  );

  const saveFilterTimeout = useRef<ReturnType<typeof setTimeout>>();

  const persistFilter = useCallback(
    (newItems: FilterItem[], newConjunction: FilterConjunction) => {
      if (saveFilterTimeout.current) clearTimeout(saveFilterTimeout.current);
      if (hydratingRef.current) return;

      if (newItems.length === 0) {
        onFilterIdChange?.(null);
        return;
      }

      saveFilterTimeout.current = setTimeout(async () => {
        const nonSearchItems = newItems.filter(
          (f) => isFilterGroup(f) || f.columnId !== "_search",
        );
        const apiItems = serializeFilters(nonSearchItems);
        if (!apiItems) return;
        const result = await saveFilterMutation.mutateAsync({
          nodeTypeId,
          filters: apiItems,
          conjunction: newConjunction,
        });
        onFilterIdChange?.(result.id);
      }, 300);
    },
    [nodeTypeId, onFilterIdChange, saveFilterMutation],
  );

  const handleFiltersChange = useCallback(
    (newItems: FilterItem[]) => {
      setFilters(newItems);
      const newConj = newItems.length === 0 ? ("and" as const) : conjunction;
      if (newItems.length === 0) setConjunction("and");
      setPages(new Map());
      setTotal(null);
      setPropertyIds(new Map());
      setSelectedIds(new Set());
      loadingPages.current.clear();
      syncedDataRef.current = null;
      persistFilter(newItems, newConj);
    },
    [conjunction, persistFilter],
  );

  const handleSort = useCallback((colId: string) => {
    setSortBy((prev) => {
      if (prev === colId) {
        setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortDirection(
          colId === "_updated" || colId === "_created" ? "desc" : "asc",
        );
      }
      return colId;
    });
    setPages(new Map());
    setTotal(null);
    setPropertyIds(new Map());
    setSelectedIds(new Set());
    loadingPages.current.clear();
    syncedDataRef.current = null;
  }, []);

  const refreshTable = useCallback(() => {
    setPages(new Map());
    setTotal(null);
    setPropertyIds(new Map());
    loadingPages.current.clear();
    syncedDataRef.current = null;
    utils.views.knowledge.graph.getNodesTable.invalidate();
  }, [utils]);

  // Records changed elsewhere while this table is open. Rather than
  // reorder rows under the user's cursor, surface a dismissible "refresh"
  // pill — they pull the change in when ready.
  const [agentChangedData, setAgentChangedData] = useState(false);
  trpc.views.knowledge.ontology.onResourceChange.useSubscription(
    { kinds: ["kg-data"] },
    {
      onData: (evt) => {
        if (evt.originId === TAB_ORIGIN_ID) return; // our own edit — already shown
        setAgentChangedData(true);
      },
    },
  );
  const applyAgentRefresh = useCallback(() => {
    setAgentChangedData(false);
    refreshTable();
  }, [refreshTable]);

  const handleBulkDelete = useCallback(async () => {
    await bulkDeleteNodes.mutateAsync({ ids: [...selectedIds] });
    setSelectedIds(new Set());
    setShowBulkDelete(false);
    if (selectedIds.has(selectedNodeId ?? "")) {
      setSelectedNodeId(null);
    }
    refreshTable();
  }, [selectedIds, bulkDeleteNodes, refreshTable, selectedNodeId]);

  const handleBulkUpdate = useCallback(
    async (colId: string, rawValue: string) => {
      const col = columns.find((c) => c.id === colId);
      if (!col) return;

      const params: {
        nodeIds: string[];
        propertyTypeId: string;
        valueText?: string | null;
        valueNumber?: string | null;
        valueDate?: string | null;
        valueBoolean?: boolean | null;
      } = {
        nodeIds: [...selectedIds],
        propertyTypeId: colId,
      };

      if (col.value_type === "boolean")
        params.valueBoolean = rawValue === "true";
      else if (col.value_type === "number") params.valueNumber = rawValue;
      else if (col.value_type === "date") params.valueDate = rawValue;
      else params.valueText = rawValue;

      await bulkUpdateProperty.mutateAsync(params);
      setSelectedIds(new Set());
      setShowBulkUpdate(false);
      refreshTable();
    },
    [selectedIds, columns, bulkUpdateProperty, refreshTable],
  );

  const [mergeError, setMergeError] = useState<string | null>(null);

  const handleBulkMerge = useCallback(
    async (targetId: string) => {
      setMergeError(null);
      try {
        const sourceIds = [...selectedIds].filter((id) => id !== targetId);
        for (const sourceId of sourceIds) {
          await mergeNodesMutation.mutateAsync({
            targetNodeId: targetId,
            sourceNodeId: sourceId,
          });
        }
        setSelectedIds(new Set());
        setShowBulkMerge(false);
        refreshTable();
      } catch (e) {
        setMergeError(e instanceof Error ? e.message : 'Merge failed');
      }
    },
    [selectedIds, mergeNodesMutation, refreshTable],
  );

  const toggleSelectAll = useCallback(() => {
    const allVisibleIds: string[] = [];
    for (const [, pageRows] of pages) {
      for (const row of pageRows) {
        allVisibleIds.push(row.id);
      }
    }
    if (selectedIds.size === allVisibleIds.length && allVisibleIds.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allVisibleIds));
    }
  }, [pages, selectedIds]);

  const toggleSelectRow = useCallback((rowId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);

  const patchRowValue = useCallback(
    (
      rowId: string,
      colId: string,
      newValue: string | number | boolean | null,
    ) => {
      setPages((prev) => {
        const next = new Map(prev);
        for (const [pageIdx, rows] of next) {
          const rowIdx = rows.findIndex((r) => r.id === rowId);
          if (rowIdx >= 0) {
            const updated = [...rows];
            updated[rowIdx] = {
              ...updated[rowIdx],
              values: { ...updated[rowIdx].values, [colId]: newValue },
            };
            next.set(pageIdx, updated);
            return next;
          }
        }
        return prev;
      });
    },
    [],
  );

  const undoPush = useTableUndoStore((s) => s.push);
  const undoPop = useTableUndoStore((s) => s.pop);

  const getRowValue = useCallback(
    (rowId: string, colId: string): string | number | boolean | null => {
      for (const [, rows] of pages) {
        const row = rows.find((r) => r.id === rowId);
        if (row) return row.values[colId] ?? null;
      }
      return null;
    },
    [pages],
  );

  const handleCellSave = useCallback(
    async (rowId: string, col: Column, rawValue: string) => {
      setEditingCell(null);

      let typedValue: string | number | boolean | null;
      if (!rawValue) {
        typedValue = null;
      } else if (col.value_type === "boolean") {
        typedValue = rawValue === "true";
      } else if (col.value_type === "number") {
        typedValue = parseFloat(rawValue);
        if (isNaN(typedValue)) typedValue = null;
      } else {
        typedValue = rawValue;
      }

      const oldValue = getRowValue(rowId, col.id);
      if (oldValue === typedValue) return;

      patchRowValue(rowId, col.id, typedValue);

      const propId = propertyIds.get(rowId)?.get(col.id);

      undoPush({
        rowId,
        colId: col.id,
        oldValue,
        newValue: typedValue,
        propertyId: propId,
        propertyTypeId: col.id,
        valueType: col.value_type,
      });

      if (!propId) {
        if (!rawValue) return;
        const createParams: {
          nodeId: string;
          propertyTypeId: string;
          valueText?: string | null;
          valueNumber?: string | null;
          valueDate?: string | null;
          valueBoolean?: boolean | null;
        } = { nodeId: rowId, propertyTypeId: col.id };
        if (col.value_type === "boolean")
          createParams.valueBoolean = rawValue === "true";
        else if (col.value_type === "number")
          createParams.valueNumber = rawValue;
        else if (col.value_type === "date") createParams.valueDate = rawValue;
        else createParams.valueText = rawValue;

        await createProperty.mutateAsync(createParams);
        for (const [pageIdx, rows] of pages) {
          if (rows.some((r) => r.id === rowId)) {
            loadingPages.current.delete(pageIdx);
            loadPage(pageIdx);
            break;
          }
        }
        if (selectedNodeId === rowId) {
          utils.views.knowledge.graph.getNode.invalidate({ id: rowId });
        }
        return;
      }

      const params: {
        propertyId: string;
        description: string;
        valueText?: string | null;
        valueNumber?: string | null;
        valueDate?: string | null;
        valueBoolean?: boolean | null;
      } = {
        propertyId: propId,
        description: "Edited from table",
      };
      if (col.value_type === "boolean")
        params.valueBoolean = rawValue ? rawValue === "true" : null;
      else if (col.value_type === "number")
        params.valueNumber = rawValue || null;
      else if (col.value_type === "date") params.valueDate = rawValue || null;
      else params.valueText = rawValue || null;

      await editProperty.mutateAsync(params);
      if (selectedNodeId === rowId) {
        utils.views.knowledge.graph.getNode.invalidate({ id: rowId });
      }
    },
    [
      propertyIds,
      patchRowValue,
      editProperty,
      createProperty,
      utils,
      selectedNodeId,
      pages,
      loadPage,
      getRowValue,
      undoPush,
    ],
  );

  const applyValueToApi = useCallback(
    async (edit: {
      rowId: string;
      propertyId: string | undefined;
      propertyTypeId: string;
      valueType: string;
      value: string | number | boolean | null;
    }) => {
      const rawValue = edit.value === null ? "" : String(edit.value);
      const propId =
        edit.propertyId ??
        propertyIds.get(edit.rowId)?.get(edit.propertyTypeId);

      if (!propId) {
        if (!rawValue) return;
        const createParams: {
          nodeId: string;
          propertyTypeId: string;
          valueText?: string | null;
          valueNumber?: string | null;
          valueDate?: string | null;
          valueBoolean?: boolean | null;
        } = { nodeId: edit.rowId, propertyTypeId: edit.propertyTypeId };
        if (edit.valueType === "boolean")
          createParams.valueBoolean = rawValue === "true";
        else if (edit.valueType === "number")
          createParams.valueNumber = rawValue;
        else if (edit.valueType === "date") createParams.valueDate = rawValue;
        else createParams.valueText = rawValue;
        await createProperty.mutateAsync(createParams);
        for (const [pageIdx, rows] of pages) {
          if (rows.some((r) => r.id === edit.rowId)) {
            loadingPages.current.delete(pageIdx);
            loadPage(pageIdx);
            break;
          }
        }
      } else {
        const params: {
          propertyId: string;
          description: string;
          valueText?: string | null;
          valueNumber?: string | null;
          valueDate?: string | null;
          valueBoolean?: boolean | null;
        } = { propertyId: propId, description: "Edited from table" };
        if (edit.valueType === "boolean")
          params.valueBoolean = rawValue ? rawValue === "true" : null;
        else if (edit.valueType === "number")
          params.valueNumber = rawValue || null;
        else if (edit.valueType === "date") params.valueDate = rawValue || null;
        else params.valueText = rawValue || null;
        await editProperty.mutateAsync(params);
      }
      if (selectedNodeId === edit.rowId) {
        utils.views.knowledge.graph.getNode.invalidate({ id: edit.rowId });
      }
    },
    [
      propertyIds,
      editProperty,
      createProperty,
      utils,
      selectedNodeId,
      pages,
      loadPage,
    ],
  );

  const handleUndo = useCallback(async () => {
    const edit = undoPop();
    if (!edit) return;
    patchRowValue(edit.rowId, edit.colId, edit.oldValue);
    await applyValueToApi({
      rowId: edit.rowId,
      propertyId: edit.propertyId,
      propertyTypeId: edit.propertyTypeId,
      valueType: edit.valueType,
      value: edit.oldValue,
    });
  }, [undoPop, patchRowValue, applyValueToApi]);

  const handleClearCell = useCallback(
    (rowId: string, colId: string) => {
      const col = columns.find((c) => c.id === colId);
      if (!col || colId.startsWith("scope:") || colId === "_displayName") return;
      handleCellSave(rowId, col, "");
    },
    [columns, handleCellSave],
  );

  const totalRows = total ?? 0;

  const visibleColumns = useMemo(() => {
    if (hasDisplayName) {
      // Display name is shown as a separate first column; no need to promote identity
      return columns;
    }
    const identityCol = columns.find(
      (c) => c.identity === "unique" || c.identity === "fuzzy",
    );
    const rest = columns.filter((c) => c !== identityCol);
    const ordered: Column[] = [];
    if (identityCol) ordered.push(identityCol);
    ordered.push(...rest);
    return ordered;
  }, [columns, hasDisplayName]);

  // All column IDs in display order for cell navigation
  const allColIds = useMemo(() => {
    const ids: string[] = [];
    if (hasDisplayName) {
      ids.push("_displayName");
      for (const sc of scopingColumns) ids.push(`scope:${sc.edgeTypeId}`);
      for (const col of visibleColumns) ids.push(col.id);
    } else {
      if (visibleColumns.length > 0) ids.push(visibleColumns[0].id);
      for (const sc of scopingColumns) ids.push(`scope:${sc.edgeTypeId}`);
      for (let i = 1; i < visibleColumns.length; i++)
        ids.push(visibleColumns[i].id);
    }
    return ids;
  }, [visibleColumns, scopingColumns, hasDisplayName]);

  // Find adjacent row by walking pages in order
  const findAdjacentRow = useCallback(
    (rowId: string, delta: 1 | -1): string | null => {
      const sortedPages = [...pages.entries()].sort((a, b) => a[0] - b[0]);
      const allRows: Row[] = [];
      for (const [, pr] of sortedPages) allRows.push(...pr);
      const idx = allRows.findIndex((r) => r.id === rowId);
      if (idx < 0) return null;
      const next = allRows[idx + delta];
      return next?.id ?? null;
    },
    [pages],
  );

  const columnDefs = useMemo(() => {
    const defs: Array<{ id: string; defaultWidth: number }> = [];
    if (hasDisplayName) {
      defs.push({ id: "col:_displayName", defaultWidth: COL_WIDTH_FIRST });
      for (const sc of scopingColumns) {
        defs.push({ id: `scope:${sc.edgeTypeId}`, defaultWidth: COL_WIDTH_SCOPED });
      }
      for (const col of visibleColumns) {
        defs.push({ id: `col:${col.id}`, defaultWidth: COL_WIDTH });
      }
    } else {
      for (const sc of scopingColumns) {
        defs.push({ id: `scope:${sc.edgeTypeId}`, defaultWidth: COL_WIDTH_SCOPED });
      }
      for (let i = 0; i < visibleColumns.length; i++) {
        defs.push({
          id: `col:${visibleColumns[i].id}`,
          defaultWidth: i === 0 ? COL_WIDTH_FIRST : COL_WIDTH,
        });
      }
    }
    defs.push({ id: "_updated", defaultWidth: COL_WIDTH_UPDATED });
    return defs;
  }, [visibleColumns, scopingColumns, hasDisplayName]);

  const {
    getWidth,
    totalWidth: tableMinWidth,
    onPointerDown: onColPointerDown,
    onPointerMove: onColPointerMove,
    onPointerUp: onColPointerUp,
  } = useColumnWidths({
    storageKey: `colWidths:nodes:${nodeTypeId}`,
    columns: columnDefs,
  });

  const allLoadedIds = useMemo(() => {
    const ids: string[] = [];
    for (const [, pageRows] of pages) {
      for (const row of pageRows) ids.push(row.id);
    }
    return ids;
  }, [pages]);

  const allSelected =
    allLoadedIds.length > 0 && allLoadedIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const scrollCellIntoView = useCallback(
    (rowId: string, colId: string) => {
      const sortedPages = [...pages.entries()].sort((a, b) => a[0] - b[0]);
      let absIdx = 0;
      let found = false;
      for (const [pageIdx, pageRows] of sortedPages) {
        const base = pageIdx * PAGE_SIZE;
        for (let i = 0; i < pageRows.length; i++) {
          if (pageRows[i].id === rowId) {
            absIdx = base + i;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) {
        virtualizer.scrollToIndex(absIdx, { align: "auto" });
      }

      const container = scrollContainerRef.current;
      if (!container) return;
      const colIdx = allColIds.indexOf(colId);
      if (colIdx < 0 || colIdx === 0) return;

      const widthKey = (id: string) =>
        id.startsWith("scope:") ? id : id === "_displayName" ? "col:_displayName" : `col:${id}`;
      const frozenWidth = COL_WIDTH_CHECKBOX + getWidth(widthKey(allColIds[0]));
      let left = frozenWidth;
      for (let i = 1; i < colIdx; i++) {
        left += getWidth(widthKey(allColIds[i]));
      }
      const colWidth = getWidth(widthKey(colId));
      const viewLeft = container.scrollLeft + frozenWidth;
      const viewRight = container.scrollLeft + container.clientWidth;

      if (left < viewLeft) {
        container.scrollLeft = left - frozenWidth;
      } else if (left + colWidth > viewRight) {
        container.scrollLeft = left + colWidth - container.clientWidth;
      }
    },
    [pages, allColIds, virtualizer, getWidth],
  );

  const moveSelection = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const cell = selectedCell;
      if (!cell) return;
      const { rowId, colId } = cell;
      const colIdx = allColIds.indexOf(colId);

      let nextRowId = rowId;
      let nextColId = colId;

      if (direction === "left" && colIdx > 0) {
        nextColId = allColIds[colIdx - 1];
      } else if (direction === "right" && colIdx < allColIds.length - 1) {
        nextColId = allColIds[colIdx + 1];
      } else if (direction === "up") {
        const prevRow = findAdjacentRow(rowId, -1);
        if (prevRow) {
          nextRowId = prevRow;
          setSelectedNodeId(prevRow);
        } else return;
      } else if (direction === "down") {
        const nextRow = findAdjacentRow(rowId, 1);
        if (nextRow) {
          nextRowId = nextRow;
          setSelectedNodeId(nextRow);
        } else return;
      } else {
        return;
      }

      setSelectedCell({ rowId: nextRowId, colId: nextColId });
      scrollCellIntoView(nextRowId, nextColId);
    },
    [selectedCell, allColIds, findAdjacentRow, scrollCellIntoView],
  );

  const navigateEdit = useCallback(
    (direction: "next" | "prev" | "down") => {
      const cell = editingCell ?? selectedCell;
      if (!cell) return;
      const { rowId, colId } = cell;
      const colIdx = allColIds.indexOf(colId);

      let nextRowId = rowId;
      let nextColId = colId;

      if (direction === "down") {
        const nr = findAdjacentRow(rowId, 1);
        if (nr) nextRowId = nr;
        else return;
      } else if (direction === "next") {
        if (colIdx < allColIds.length - 1) {
          nextColId = allColIds[colIdx + 1];
        } else {
          const nr = findAdjacentRow(rowId, 1);
          if (nr && allColIds.length > 0) {
            nextRowId = nr;
            nextColId = allColIds[0];
          } else return;
        }
      } else {
        if (colIdx > 0) {
          nextColId = allColIds[colIdx - 1];
        } else {
          const pr = findAdjacentRow(rowId, -1);
          if (pr && allColIds.length > 0) {
            nextRowId = pr;
            nextColId = allColIds[allColIds.length - 1];
          } else return;
        }
      }

      const target = { rowId: nextRowId, colId: nextColId };
      setSelectedCell(target);
      setEditingCell(target);
      setSelectedNodeId(nextRowId);
      scrollCellIntoView(nextRowId, nextColId);
    },
    [editingCell, selectedCell, allColIds, findAdjacentRow, scrollCellIntoView],
  );

  // Keyboard handler: arrow keys, Enter, Escape, Backspace/Delete, Ctrl+Z, type-to-edit
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl/Cmd+Z for undo works globally (even when not focused on a cell)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        handleUndo();
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!selectedCell) return;

      const { rowId, colId } = selectedCell;

      if (!editingCell) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          moveSelection("up");
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveSelection("down");
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          moveSelection("left");
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          moveSelection("right");
          return;
        }

        if (e.key === "Enter") {
          e.preventDefault();
          if (!colId.startsWith("scope:") && colId !== "_displayName") {
            setEditingCell({ rowId, colId });
          }
          return;
        }

        if (e.key === "Escape") {
          setSelectedCell(null);
          return;
        }

        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          handleClearCell(rowId, colId);
          return;
        }

        if (
          e.key.length === 1 &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !colId.startsWith("scope:") &&
          colId !== "_displayName"
        ) {
          setEditingCell({ rowId, colId });
          return;
        }
      }

      if (editingCell && e.key === "Escape") {
        setEditingCell(null);
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCell, editingCell, moveSelection, handleClearCell, handleUndo]);

  const visiblePageIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const item of virtualItems) {
      indices.add(Math.floor(item.index / PAGE_SIZE));
    }
    return indices;
  }, [virtualItems]);

  for (const pageIndex of visiblePageIndices) {
    if (!pages.has(pageIndex) && !loadingPages.current.has(pageIndex)) {
      loadPage(pageIndex);
    }
  }

  const getRow = (index: number): Row | null => {
    const pageIndex = Math.floor(index / PAGE_SIZE);
    const pageRows = pages.get(pageIndex);
    if (!pageRows) return null;
    return pageRows[index - pageIndex * PAGE_SIZE] ?? null;
  };

  return (
    <>
      <div className="flex h-full flex-col">
       <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Search + filter + count bar */}
          <div className="flex min-h-10 shrink-0 items-start justify-between border-b border-gray-100 px-4 py-1.5">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <TableFilterBar
                ref={filterBarRef}
                columns={filterColumns}
                items={filters}
                conjunction={conjunction}
                onChange={handleFiltersChange}
                onConjunctionChange={(c) => {
                  setConjunction(c);
                  persistFilter(filters, c);
                  // Re-fetch with new conjunction
                  setPages(new Map());
                  setTotal(null);
                  loadingPages.current.clear();
                  syncedDataRef.current = null;
                }}
                onParseNaturalLanguage={handleParseNl}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {agentChangedData && (
                <button
                  onClick={applyAgentRefresh}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
                  title="Records changed elsewhere — refresh to see them"
                >
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  Refresh
                </button>
              )}
              {total !== null && (
                <span className="shrink-0 whitespace-nowrap text-[12px] text-gray-400 py-1">
                  {total.toLocaleString()} record{total !== 1 ? "s" : ""}
                </span>
              )}
              {showCreateButton && (
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-600"
                >
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New
                </button>
              )}
            </div>
          </div>

          {/* Bulk action toolbar */}
          {someSelected && (
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-primary/20 bg-primary/5 px-4">
              <span className="text-[13px] font-medium text-gray-700">
                {selectedIds.size} selected
              </span>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-gray-500 transition-colors hover:bg-gray-100"
              >
                <X size={12} />
                Clear
              </button>
              <div className="mx-1 h-4 w-px bg-gray-300" />
              <button
                onClick={() => setShowBulkUpdate(true)}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-100"
              >
                <Pencil size={12} />
                Edit
              </button>
              {selectedIds.size >= 2 && (
                <button
                  onClick={() => setShowBulkMerge(true)}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-100"
                >
                  <Merge size={12} />
                  Merge
                </button>
              )}
              <button
                onClick={() => setShowBulkDelete(true)}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50"
              >
                <Trash2 size={12} />
                Delete
              </button>
            </div>
          )}

          {/* Table */}
          <div
            ref={scrollContainerRef}
            data-nodes-table
            className="flex-1 overflow-auto"
          >
            <div style={{ minWidth: tableMinWidth + COL_WIDTH_CHECKBOX }}>
              {/* Sticky header */}
              <div className="sticky top-0 z-10 flex border-b border-gray-200 bg-gray-50/95 backdrop-blur-sm">
                {/* Sticky checkbox */}
                <div
                  style={{ width: COL_WIDTH_CHECKBOX }}
                  className="sticky left-0 z-20 flex shrink-0 items-center justify-center bg-gray-50/95 backdrop-blur-sm"
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 accent-primary"
                  />
                </div>
                {/* Sticky first column header */}
                {hasDisplayName ? (
                  <div
                    style={{
                      width: getWidth("col:_displayName"),
                      left: COL_WIDTH_CHECKBOX,
                    }}
                    className="sticky z-20 group/hdr relative shrink-0 select-none bg-gray-50/95 px-3 py-2.5 text-[12px] font-medium text-gray-500 backdrop-blur-sm"
                  >
                    <span className="flex items-center gap-1.5">
                      <Type className="h-3 w-3 text-gray-400" />
                      <span className="truncate">Name</span>
                    </span>
                    <div
                      className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
                      onPointerDown={(e) => onColPointerDown("col:_displayName", e)}
                      onPointerMove={onColPointerMove}
                      onPointerUp={onColPointerUp}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="pointer-events-none absolute -right-[4px] top-0 h-full w-[4px] bg-gradient-to-r from-black/[0.03] to-transparent" />
                  </div>
                ) : visibleColumns.length > 0 ? (
                  (() => {
                    const col = visibleColumns[0];
                    const colId = `col:${col.id}`;
                    const isSorted = sortBy === col.id;
                    return (
                      <div
                        key={colId}
                        style={{
                          width: getWidth(colId),
                          left: COL_WIDTH_CHECKBOX,
                        }}
                        className="sticky z-20 group/hdr relative shrink-0 cursor-pointer select-none bg-gray-50/95 px-3 py-2.5 text-[12px] font-medium text-gray-500 backdrop-blur-sm hover:text-gray-800"
                        onClick={() => handleSort(col.id)}
                      >
                        <span className="flex items-center gap-1.5">
                          <ColumnTypeIcon valueType={col.value_type} />
                          <span className="truncate">{col.name}</span>
                          <span className="ml-auto pl-1">
                            {isSorted ? (
                              <span className="text-[9px]">
                                {sortDirection === "asc" ? "▲" : "▼"}
                              </span>
                            ) : (
                              <span className="text-[9px] opacity-0 transition-opacity group-hover/hdr:opacity-40">
                                ▲
                              </span>
                            )}
                          </span>
                        </span>
                        <div
                          className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
                          onPointerDown={(e) => onColPointerDown(colId, e)}
                          onPointerMove={onColPointerMove}
                          onPointerUp={onColPointerUp}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="pointer-events-none absolute -right-[4px] top-0 h-full w-[4px] bg-gradient-to-r from-black/[0.03] to-transparent" />
                      </div>
                    );
                  })()
                ) : null}
                {scopingColumns.map((sc) => {
                  const colId = `scope:${sc.edgeTypeId}`;
                  const isSorted = sortBy === colId;
                  return (
                    <div
                      key={colId}
                      style={{ width: getWidth(colId) }}
                      className="group/hdr relative shrink-0 cursor-pointer select-none px-3 py-2.5 text-[12px] font-medium text-gray-500 hover:text-gray-800"
                      onClick={() => handleSort(colId)}
                    >
                      <span className="flex items-center gap-1.5">
                        <List className="h-3 w-3 text-gray-400" />
                        <span className="truncate">
                          {sc.targetNodeTypeName}
                        </span>
                        <span className="ml-auto pl-1">
                          {isSorted ? (
                            <span className="text-[9px]">
                              {sortDirection === "asc" ? "▲" : "▼"}
                            </span>
                          ) : (
                            <span className="text-[9px] opacity-0 transition-opacity group-hover/hdr:opacity-40">
                              ▲
                            </span>
                          )}
                        </span>
                      </span>
                      <div
                        className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
                        onPointerDown={(e) => onColPointerDown(colId, e)}
                        onPointerMove={onColPointerMove}
                        onPointerUp={onColPointerUp}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  );
                })}
                {(hasDisplayName ? visibleColumns : visibleColumns.slice(1)).map((col) => {
                  const colId = `col:${col.id}`;
                  const isSorted = sortBy === col.id;
                  const hasEnum =
                    Array.isArray(col.enum_values) &&
                    col.enum_values.length > 0;
                  return (
                    <div
                      key={colId}
                      style={{ width: getWidth(colId) }}
                      className="group/hdr relative shrink-0 cursor-pointer select-none px-3 py-2.5 text-[12px] font-medium text-gray-500 hover:text-gray-800"
                      onClick={() => handleSort(col.id)}
                    >
                      <span className="flex items-center gap-1.5">
                        {hasEnum ? (
                          <List className="h-3 w-3 text-gray-400" />
                        ) : (
                          <ColumnTypeIcon valueType={col.value_type} />
                        )}
                        <span className="truncate">{col.name}</span>
                        <span className="ml-auto pl-1">
                          {isSorted ? (
                            <span className="text-[9px]">
                              {sortDirection === "asc" ? "▲" : "▼"}
                            </span>
                          ) : (
                            <span className="text-[9px] opacity-0 transition-opacity group-hover/hdr:opacity-40">
                              ▲
                            </span>
                          )}
                        </span>
                      </span>
                      <div
                        className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
                        onPointerDown={(e) => onColPointerDown(colId, e)}
                        onPointerMove={onColPointerMove}
                        onPointerUp={onColPointerUp}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  );
                })}
                <div
                  style={{ width: getWidth("_updated") }}
                  className="group/hdr relative shrink-0 cursor-pointer select-none px-3 py-2.5 text-[12px] font-medium text-gray-500 hover:text-gray-800"
                  onClick={() => handleSort("_updated")}
                >
                  <span className="flex items-center gap-1.5">
                    <Calendar className="h-3 w-3 text-gray-400" />
                    <span className="truncate">Updated</span>
                    <span className="ml-auto pl-1">
                      {sortBy === "_updated" ? (
                        <span className="text-[9px]">
                          {sortDirection === "asc" ? "▲" : "▼"}
                        </span>
                      ) : (
                        <span className="text-[9px] opacity-0 transition-opacity group-hover/hdr:opacity-40">
                          ▼
                        </span>
                      )}
                    </span>
                  </span>
                  <div
                    className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
                    onPointerDown={(e) => onColPointerDown("_updated", e)}
                    onPointerMove={onColPointerMove}
                    onPointerUp={onColPointerUp}
                  />
                </div>
              </div>

              {/* Body */}
              {initialQuery.isLoading ? (
                <div className="space-y-1 p-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="flex">
                      <div
                        style={{ width: COL_WIDTH_CHECKBOX }}
                        className="shrink-0"
                      />
                      {hasDisplayName && (
                        <div
                          style={{ width: getWidth("col:_displayName") }}
                          className="h-8 animate-pulse rounded bg-gray-100 px-3"
                        />
                      )}
                      {scopingColumns.map((sc) => (
                        <div
                          key={sc.edgeTypeId}
                          style={{ width: getWidth(`scope:${sc.edgeTypeId}`) }}
                          className="h-8 animate-pulse rounded bg-gray-50 px-3"
                        />
                      ))}
                      {visibleColumns.map((col, j) => (
                        <div
                          key={col.id}
                          style={{ width: getWidth(`col:${col.id}`) }}
                          className={`h-8 animate-pulse rounded px-3 ${!hasDisplayName && j === 0 ? "bg-gray-100" : "bg-gray-50"}`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ) : totalRows === 0 ? (
                <div className="flex flex-col items-center gap-3 pt-16">
                  <svg
                    className="h-10 w-10 text-gray-200"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <path d="M3 9h18" />
                    <path d="M9 3v18" />
                  </svg>
                  <p className="text-[14px] text-gray-400">
                    {searchFromFilters ? "No results found" : "No data yet"}
                  </p>
                </div>
              ) : (
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    position: "relative",
                  }}
                >
                  {virtualItems.map((virtualRow) => {
                    const row = getRow(virtualRow.index);
                    const isSelected = row?.id === selectedNodeId;
                    const isChecked = selectedIds.has(row?.id ?? "");
                    const rowBg = isSelected
                      ? "bg-primary/5"
                      : isChecked
                        ? "bg-primary/[0.03]"
                        : "bg-white";
                    // Opaque equivalents for sticky cells so scrolling content doesn't bleed through
                    const stickyBg = isSelected
                      ? "bg-[#f6f3ff]"
                      : isChecked
                        ? "bg-[#faf9ff]"
                        : "bg-white";

                    return (
                      <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        ref={virtualizer.measureElement}
                        className={`group/row absolute left-0 top-0 flex cursor-pointer border-b border-gray-100 transition-colors ${rowBg} ${!isSelected && !isChecked ? "hover:bg-gray-50/80" : ""}`}
                        style={{
                          height: ROW_HEIGHT,
                          minWidth: tableMinWidth + COL_WIDTH_CHECKBOX,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        onClick={() => {
                          if (!row) return;
                          setSelectedNodeId(row.id);
                          // Select first column cell
                          if (hasDisplayName) {
                            setSelectedCell({ rowId: row.id, colId: "_displayName" });
                          } else if (visibleColumns.length > 0) {
                            setSelectedCell({ rowId: row.id, colId: visibleColumns[0].id });
                          }
                          setEditingCell(null);
                        }}
                      >
                        {/* Selected row accent */}
                        {isSelected && (
                          <div className="absolute left-0 top-0 h-full w-[2px] bg-primary" />
                        )}
                        {/* Sticky checkbox */}
                        <div
                          style={{ width: COL_WIDTH_CHECKBOX }}
                          className={`sticky left-0 z-10 flex shrink-0 items-center justify-center ${stickyBg} ${!isSelected && !isChecked ? "group-hover/row:bg-[#f9fafb]" : ""}`}
                          onClick={(e) => row && toggleSelectRow(row.id, e)}
                        >
                          {row && (
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {}}
                              className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 accent-primary"
                            />
                          )}
                        </div>
                        {row ? (
                          <>
                            {/* Sticky first column */}
                            {hasDisplayName ? (
                              <div
                                style={{
                                  width: getWidth("col:_displayName"),
                                  left: COL_WIDTH_CHECKBOX,
                                }}
                                className={`sticky z-10 flex items-center truncate px-3 text-[13px] font-medium text-gray-900 ${stickyBg} ${!isSelected && !isChecked ? "group-hover/row:bg-[#f9fafb]" : ""} ${selectedCell?.rowId === row.id && selectedCell?.colId === "_displayName" ? "outline outline-2 outline-primary" : ""}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedCell({ rowId: row.id, colId: "_displayName" });
                                  setSelectedNodeId(row.id);
                                  setEditingCell(null);
                                }}
                              >
                                <span className="truncate">
                                  {row.displayName || (
                                    <span className="text-gray-300">&mdash;</span>
                                  )}
                                </span>
                                <div className="pointer-events-none absolute -right-[4px] top-0 h-full w-[4px] bg-gradient-to-r from-black/[0.03] to-transparent" />
                              </div>
                            ) : visibleColumns.length > 0 ? (
                              (() => {
                                const col = visibleColumns[0];
                                const isCellSelected =
                                  selectedCell?.rowId === row.id &&
                                  selectedCell?.colId === col.id;
                                const isEditing =
                                  editingCell?.rowId === row.id &&
                                  editingCell?.colId === col.id;
                                const colWidth = getWidth(`col:${col.id}`);

                                if (isEditing) {
                                  return (
                                    <InlineEditCell
                                      key={col.id}
                                      value={row.values[col.id]}
                                      valueType={col.value_type}
                                      enumValues={col.enum_values}
                                      colWidth={colWidth}
                                      isFirst={true}
                                      isSelected={true}
                                      className={`sticky z-10 ${stickyBg}`}
                                      style={{ left: COL_WIDTH_CHECKBOX }}
                                      onSave={(rawValue) =>
                                        handleCellSave(row.id, col, rawValue)
                                      }
                                      onCancel={() => setEditingCell(null)}
                                      onTab={() => navigateEdit("next")}
                                      onShiftTab={() => navigateEdit("prev")}
                                      onEnterDown={() =>
                                        setEditingCell(null)
                                      }
                                    >
                                      <div className="pointer-events-none absolute -right-[4px] top-0 h-full w-[4px] bg-gradient-to-r from-black/[0.03] to-transparent" />
                                    </InlineEditCell>
                                  );
                                }

                                return (
                                  <div
                                    key={col.id}
                                    style={{
                                      width: colWidth,
                                      left: COL_WIDTH_CHECKBOX,
                                    }}
                                    className={`sticky z-10 flex items-center truncate px-3 text-[13px] font-medium text-gray-900 ${stickyBg} ${!isSelected && !isChecked ? "group-hover/row:bg-[#f9fafb]" : ""} ${isCellSelected ? "outline outline-2 outline-primary" : ""}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedCell({
                                        rowId: row.id,
                                        colId: col.id,
                                      });
                                      setSelectedNodeId(row.id);
                                      setEditingCell(null);
                                    }}
                                    onDoubleClick={(e) => {
                                      e.stopPropagation();
                                      setEditingCell({
                                        rowId: row.id,
                                        colId: col.id,
                                      });
                                    }}
                                  >
                                    <span className="truncate">
                                      {formatCellValue(
                                        row.values[col.id],
                                        col.value_type,
                                      ) || (
                                        <span className="text-gray-300">
                                          &mdash;
                                        </span>
                                      )}
                                    </span>
                                    <div className="pointer-events-none absolute -right-[4px] top-0 h-full w-[4px] bg-gradient-to-r from-black/[0.03] to-transparent" />
                                  </div>
                                );
                              })()
                            ) : null}
                            {scopingColumns.map((sc) => {
                              const sv = row.scopingValues[sc.edgeTypeId];
                              const colId = `scope:${sc.edgeTypeId}`;
                              const isCellSelected =
                                selectedCell?.rowId === row.id &&
                                selectedCell?.colId === colId;
                              return (
                                <div
                                  key={colId}
                                  style={{ width: getWidth(colId) }}
                                  className={`flex items-center overflow-hidden px-3 ${isCellSelected ? "ring-2 ring-inset ring-primary" : ""}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedCell({ rowId: row.id, colId });
                                    setSelectedNodeId(row.id);
                                    setEditingCell(null);
                                  }}
                                >
                                  {sv ? (
                                    <span
                                      className="inline-flex cursor-pointer items-center truncate rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 transition-colors hover:bg-gray-200"
                                      title={sv.parentName}
                                    >
                                      {sv.parentName}
                                    </span>
                                  ) : null}
                                </div>
                              );
                            })}
                            {(hasDisplayName ? visibleColumns : visibleColumns.slice(1)).map((col) => {
                              const isCellSelected =
                                selectedCell?.rowId === row.id &&
                                selectedCell?.colId === col.id;
                              const isEditing =
                                editingCell?.rowId === row.id &&
                                editingCell?.colId === col.id;
                              const colWidth = getWidth(`col:${col.id}`);

                              if (isEditing) {
                                return (
                                  <InlineEditCell
                                    key={col.id}
                                    value={row.values[col.id]}
                                    valueType={col.value_type}
                                    enumValues={col.enum_values}
                                    colWidth={colWidth}
                                    isFirst={false}
                                    isSelected={true}
                                    onSave={(rawValue) =>
                                      handleCellSave(row.id, col, rawValue)
                                    }
                                    onCancel={() => setEditingCell(null)}
                                    onTab={() => navigateEdit("next")}
                                    onShiftTab={() => navigateEdit("prev")}
                                    onEnterDown={() => {
                                      // Enter in edit mode: save and exit editing (stay selected)
                                      setEditingCell(null);
                                    }}
                                  />
                                );
                              }

                              const formatted = formatCellValue(
                                row.values[col.id],
                                col.value_type,
                              );

                              return (
                                <div
                                  key={col.id}
                                  style={{ width: colWidth }}
                                  className={`group/cell flex items-center truncate px-3 text-[13px] text-gray-600 ${isCellSelected ? "ring-2 ring-inset ring-primary" : ""}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedCell({
                                      rowId: row.id,
                                      colId: col.id,
                                    });
                                    setSelectedNodeId(row.id);
                                    setEditingCell(null);
                                  }}
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    setEditingCell({
                                      rowId: row.id,
                                      colId: col.id,
                                    });
                                  }}
                                >
                                  <span className="truncate">
                                    {formatted || null}
                                  </span>
                                  {!formatted && (
                                    <Pencil
                                      size={11}
                                      className="text-gray-300 opacity-0 transition-opacity group-hover/row:opacity-100"
                                    />
                                  )}
                                </div>
                              );
                            })}
                            <div
                              style={{ width: getWidth("_updated") }}
                              className="flex items-center px-3 text-[12px] text-gray-400"
                            >
                              {formatRelativeDate(row.updatedAt)}
                            </div>
                          </>
                        ) : (
                          <>
                            {/* Sticky first column skeleton */}
                            {(hasDisplayName || visibleColumns.length > 0) && (
                              <div
                                style={{
                                  width: getWidth(
                                    hasDisplayName ? "col:_displayName" : `col:${visibleColumns[0].id}`,
                                  ),
                                  left: COL_WIDTH_CHECKBOX,
                                }}
                                className="sticky z-10 flex items-center bg-white px-3"
                              >
                                <div className="h-3.5 w-28 animate-pulse rounded bg-gray-100" />
                              </div>
                            )}
                            {scopingColumns.map((sc) => (
                              <div
                                key={sc.edgeTypeId}
                                style={{
                                  width: getWidth(`scope:${sc.edgeTypeId}`),
                                }}
                                className="flex items-center px-3"
                              >
                                <div className="h-3.5 w-20 animate-pulse rounded bg-gray-50" />
                              </div>
                            ))}
                            {(hasDisplayName ? visibleColumns : visibleColumns.slice(1)).map((col) => (
                              <div
                                key={col.id}
                                style={{ width: getWidth(`col:${col.id}`) }}
                                className="flex items-center px-3"
                              >
                                <div className="h-3.5 w-20 animate-pulse rounded bg-gray-50" />
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right panel — node detail, only when a row is selected
            (desktop only). */}
        {!isMobile && selectedNodeId && (
          <ResizablePanel
            side="right"
            defaultWidth={384}
            minWidth={280}
            maxWidth={520}
            storageKey="panel:nodes:right"
            className="border-l border-gray-100 overflow-y-auto bg-white"
          >
            {selectedNodeId ? (
              <NodeDetailDrawer
                nodeId={selectedNodeId}
                onClose={() => setSelectedNodeId(null)}
                onNavigate={(nodeId) => setSelectedNodeId(nodeId)}
                onDeleted={() => {
                  setSelectedNodeId(null);
                  refreshTable();
                }}
                onPropertyChanged={() => {
                  for (const [pageIdx, rows] of pages) {
                    if (rows.some((r) => r.id === selectedNodeId)) {
                      loadingPages.current.delete(pageIdx);
                      loadPage(pageIdx);
                      break;
                    }
                  }
                }}
                ontology={ontology}
              />
            ) : null}
          </ResizablePanel>
        )}
       </div>

       {/* Mobile: re-open affordance under the table — the drawer itself
           opens on row tap. This must sit INSIDE the height-constrained
           column; as a sibling of the h-full root it rendered below the
           viewport and was unreachable. */}
       {isMobile && selectedNodeId && (
         <MobileBottomBar>
           <button
             onClick={() => setRightOpen(true)}
             className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-100"
           >
             <PanelRight size={14} />
             Node Details
           </button>
         </MobileBottomBar>
       )}
      </div>

      {/* Mobile node-detail drawer (fixed overlay) */}
      {isMobile && selectedNodeId && (
          <PanelDrawer
            side="right"
            open={rightOpen}
            onClose={() => setRightOpen(false)}
            title="Node Details"
          >
            {selectedNodeId ? (
              <NodeDetailDrawer
                nodeId={selectedNodeId}
                onClose={() => setSelectedNodeId(null)}
                onNavigate={(nodeId) => setSelectedNodeId(nodeId)}
                onDeleted={() => {
                  setSelectedNodeId(null);
                  refreshTable();
                }}
                onPropertyChanged={() => {
                  for (const [pageIdx, rows] of pages) {
                    if (rows.some((r) => r.id === selectedNodeId)) {
                      loadingPages.current.delete(pageIdx);
                      loadPage(pageIdx);
                      break;
                    }
                  }
                }}
                ontology={ontology}
              />
            ) : null}
          </PanelDrawer>
      )}

      {/* Dialogs */}
      {showCreate && (
        <CreateNodeDialog
          nodeTypeId={nodeTypeId}
          columns={columns}
          onCreated={refreshTable}
          onClose={() => setShowCreate(false)}
        />
      )}
      {showBulkDelete && (
        <BulkDeleteDialog
          count={selectedIds.size}
          onConfirm={handleBulkDelete}
          onClose={() => setShowBulkDelete(false)}
          isLoading={bulkDeleteNodes.isLoading}
        />
      )}
      {showBulkUpdate && (
        <BulkUpdateDialog
          columns={columns}
          count={selectedIds.size}
          onConfirm={handleBulkUpdate}
          onClose={() => setShowBulkUpdate(false)}
          isLoading={bulkUpdateProperty.isLoading}
        />
      )}
      {showBulkMerge && (
        <BulkMergeDialog
          selectedIds={selectedIds}
          rows={pages}
          columns={columns}
          onConfirm={handleBulkMerge}
          onClose={() => { setShowBulkMerge(false); setMergeError(null); }}
          isLoading={mergeNodesMutation.isLoading}
          error={mergeError}
        />
      )}
    </>
  );
});
