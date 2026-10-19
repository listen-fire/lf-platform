// The display data cached on a linked object for an Attio record: simple
// scalar values flattened out of Attio's typed-value arrays, plus the web url.

export function buildRecordData(record: { id: { object_id: string; record_id: string }; web_url?: string; values: Record<string, unknown> }, objectId: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // Extract simple string/number values from Attio's nested value format
  for (const [key, val] of Object.entries(record.values)) {
    if (!Array.isArray(val) || val.length === 0) continue;
    const first = val[0] as Record<string, unknown>;
    // Attio stores values as arrays of typed objects
    if (typeof first === 'object' && first !== null) {
      const displayValue = first.value ?? first.full_name ?? first.first_name ?? first.domain ?? first.email_address ?? first.original_email_address;
      if (displayValue != null && typeof displayValue !== 'object') {
        data[key] = displayValue;
      }
    }
  }

  if (record.web_url) {
    data.url = record.web_url;
  }

  return data;
}
