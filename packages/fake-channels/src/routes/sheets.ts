import { Router, Request } from 'express';
import type { EntityStore } from '../store';

const SVC = 'sheets';

export function sheetsRoutes(store: EntityStore): Router {
  const r = Router();

  // GET spreadsheet metadata
  r.get('/v4/spreadsheets/:spreadsheetId', (req, res) => {
    const spreadsheetId = req.params.spreadsheetId;
    const spreadsheet = store.get(SVC, 'spreadsheet', spreadsheetId);
    if (!spreadsheet) return res.status(404).json({ error: 'Spreadsheet not found' });
    // Serve table ranges with a CONCRETE end row (header + stored data rows)
    // so the client's range math sees appended rows — a real native Table's
    // range grows the same way.
    const data = JSON.parse(JSON.stringify(spreadsheet.data)) as {
      sheets?: { tables?: { tableId: number | string; range: { startRowIndex: number; endRowIndex: number } }[] }[];
    };
    for (const sheet of data.sheets ?? []) {
      for (const table of sheet.tables ?? []) {
        const rowCount = store
          .list(SVC, 'row')
          .filter((r) => (r.data as { table_id?: unknown }).table_id === table.tableId).length;
        table.range.endRowIndex = table.range.startRowIndex + 1 + rowCount;
      }
    }
    res.json(data);
  });

  // Create a new spreadsheet (agent-created report sheets — drive.file
  // auto-owns app-created files, so creation needs no picker).
  r.post('/v4/spreadsheets', (req: Request, res) => {
    const id = `created-${store.nextId(SVC, 'spreadsheet')}`;
    const title = req.body?.properties?.title ?? 'Untitled spreadsheet';
    const data = {
      spreadsheetId: id,
      properties: { title },
      sheets: [{ properties: { sheetId: 0, title: 'Sheet1', gridProperties: { columnCount: 26 } }, tables: [] }],
    };
    store.create(SVC, 'spreadsheet', data, id);
    res.json(data);
  });

  // Batch update (appendCells for table rows)
  r.post('/v4/spreadsheets/:spreadsheetId\\:batchUpdate', (req: Request, res) => {
    const spreadsheetId = (req.params as Record<string, string>).spreadsheetId;
    const replies: unknown[] = [];
    for (const request of req.body.requests || []) {
      if (request.addNamedRange) {
        const nr = request.addNamedRange.namedRange ?? {};
        const spreadsheet = store.get(SVC, 'spreadsheet', spreadsheetId);
        if (spreadsheet) {
          const data = spreadsheet.data as { namedRanges?: unknown[] };
          const namedRangeId = `nr-${store.nextId(SVC, 'namedrange')}`;
          const created = { namedRangeId, name: nr.name, range: nr.range };
          data.namedRanges = [...(data.namedRanges ?? []), created];
          store.create(SVC, 'spreadsheet', data, spreadsheetId);
          replies.push({ addNamedRange: { namedRange: created } });
          continue;
        }
      }
      if (request.updateCells) {
        const { start, rows } = request.updateCells;
        const dataRows = store
          .list(SVC, 'row')
          .filter((r) => (r.data as { spreadsheet_id?: string }).spreadsheet_id === spreadsheetId);
        // start.rowIndex is 0-based absolute; header is row 0, so data ordinal
        // = rowIndex - 1 (the seed table starts at A1).
        const target = dataRows[start.rowIndex - 1];
        if (target) {
          const values = ((target.data as { values?: unknown[] }).values ?? []) as unknown[];
          const newCells = rows?.[0]?.values ?? [];
          for (let i = 0; i < newCells.length; i++) {
            values[start.columnIndex + i] = newCells[i];
          }
          store.create(SVC, 'row', { ...(target.data as object), values }, target.id);
        } else {
          // A cell outside the table's data rows (e.g. a named-range write):
          // store it as a standalone cell, keyed by position — a repeat write
          // to the same position OVERWRITES (that's the contract under test).
          const newCells = rows?.[0]?.values ?? [];
          for (let i = 0; i < newCells.length; i++) {
            const key = `${spreadsheetId}:${start.sheetId}:${start.rowIndex}:${start.columnIndex + i}`;
            store.create(SVC, 'cell', {
              spreadsheet_id: spreadsheetId,
              sheet_id: start.sheetId,
              row_index: start.rowIndex,
              column_index: start.columnIndex + i,
              value: newCells[i],
            }, key);
          }
        }
      }
      if (request.appendCells) {
        const { sheetId, tableId, rows } = request.appendCells;
        for (const row of rows || []) {
          const rowId = store.nextId(SVC, 'row');
          store.create(
            SVC,
            'row',
            {
              spreadsheet_id: spreadsheetId,
              sheet_id: sheetId,
              table_id: tableId,
              values: row.values,
            },
            rowId,
          );
        }
      }
    }
    res.json({ spreadsheetId, replies });
  });

  // Values GET — serve a table's data rows as plain values. The fake ignores
  // the numeric extent and slices stored appended rows by the range's start
  // row (row 2 == first data row).
  r.get('/v4/spreadsheets/:spreadsheetId/values/:range', (req: Request, res) => {
    const params = req.params as Record<string, string>;
    const decoded = decodeURIComponent(params.range);
    // A NAMED RANGE read (`values.get?range=FX_Rate`) — a bare name (no `!`).
    // Resolve it to its grid cell and serve that cell's stored value, so a
    // `named cells` read round-trips the value a named-range write set.
    if (!decoded.includes('!')) {
      const spreadsheet = store.get(SVC, 'spreadsheet', params.spreadsheetId);
      const named = (
        (spreadsheet?.data as { namedRanges?: { name?: string; range?: { sheetId?: number; startRowIndex?: number; startColumnIndex?: number } }[] })
          ?.namedRanges ?? []
      ).find((n) => n.name === decoded);
      if (named?.range) {
        const key = `${params.spreadsheetId}:${named.range.sheetId ?? 0}:${named.range.startRowIndex ?? 0}:${named.range.startColumnIndex ?? 0}`;
        const cell = store.get(SVC, 'cell', key);
        const stored = (cell?.data as { value?: unknown } | undefined)?.value;
        if (stored === undefined) return res.json({ range: decoded, values: [] });
        // `values.get` returns PLAIN scalars; the cell is stored as the raw
        // `updateCells` shape (`{ userEnteredValue: {...} }`), so unwrap it the
        // same way the table-row read below does.
        const u = (stored as { userEnteredValue?: Record<string, unknown> })?.userEnteredValue;
        const plain = u ? (u.stringValue ?? u.numberValue ?? u.boolValue ?? '') : stored;
        return res.json({ range: decoded, values: [[plain]] });
      }
    }
    // A plain-sheet HEADER request (`'Sheet1'!1:1` / `'Sheet1'!A1:…`) — the
    // range starts at row 1. Serve the tab's stored `headerRow` so
    // `getSheetColumns` / `addRow` discover the columns.
    const headerMatch = decoded.match(/^'?([^'!]+)'?![A-Z]*(\d+)/);
    if (headerMatch && Number(headerMatch[2]) === 1) {
      const tabTitle = headerMatch[1];
      const spreadsheet = store.get(SVC, 'spreadsheet', params.spreadsheetId);
      const sheet = (
        (spreadsheet?.data as { sheets?: { properties?: { title?: string }; headerRow?: string[] }[] })
          ?.sheets ?? []
      ).find((s) => s.properties?.title === tabTitle);
      if (sheet?.headerRow) {
        return res.json({ range: decoded, values: [sheet.headerRow] });
      }
    }
    const startRow = Number((decoded.match(/![A-Z]+(\d+):/) ?? [])[1] ?? 2);
    const rows = store
      .list(SVC, 'row')
      .filter((r) => (r.data as { spreadsheet_id?: string }).spreadsheet_id === params.spreadsheetId);
    const plain = rows.map((r) =>
      ((r.data as { values?: { userEnteredValue?: Record<string, unknown> }[] }).values ?? []).map(
        (v) => {
          const u = v?.userEnteredValue ?? {};
          return (u.stringValue ?? u.numberValue ?? u.boolValue ?? '') as unknown;
        },
      ),
    );
    // Data rows begin at sheet row 2; slice if the range starts deeper.
    res.json({ range: decoded, values: plain.slice(Math.max(0, startRow - 2)) });
  });

  // Values append (for google-spreadsheet SDK addRow)
  r.post('/v4/spreadsheets/:spreadsheetId/values/:range\\:append', (req: Request, res) => {
    const params = req.params as Record<string, string>;
    const rowId = store.nextId(SVC, 'row');
    store.create(
      SVC,
      'row',
      {
        spreadsheet_id: params.spreadsheetId,
        range: params.range,
        values: req.body.values,
      },
      rowId,
    );
    res.json({
      spreadsheetId: params.spreadsheetId,
      tableRange: params.range,
      updates: { updatedRows: 1 },
    });
  });

  // Drive permissions (sharing an app-created sheet with teammates).
  r.post('/drive/v3/files/:id/permissions', (req, res) => {
    store.create(SVC, 'permission', {
      file_id: req.params.id,
      role: req.body.role,
      type: req.body.type,
      email: req.body.emailAddress,
    });
    res.json({ id: store.nextId(SVC, 'permission-id'), role: req.body.role });
  });

  return r;
}
