// A test run of an automation pinned to a version this build does not run is
// refused by the registry before anything reads the program: no introspection
// of the source system, no model inventing an event, no catalog assembled.

jest.mock('../../storage/tg_table', () => ({ loadTriggerById: jest.fn() }));
jest.mock('../store', () => ({ getMovementRow: jest.fn() }));
jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));
jest.mock('../../../../lib/anthropic', () => ({ anthropicChat: jest.fn() }));
jest.mock('../catalog', () => ({ runCatalogSnapshotForTeam: jest.fn() }));
jest.mock('../carried_run', () => ({
  carriedRunLaneOf: jest.requireActual('../carried_run').carriedRunLaneOf,
  runCarriedSegment: jest.fn(async () => ({ movementName: 'echo', writes: [], extractionSites: {}, trace: [] })),
}));
jest.mock('@listen-fire/legacy-engine/dispatch', () => ({
  ...jest.requireActual('@listen-fire/legacy-engine/services/movement_engine/engine_choice'),
  runMovement: jest.fn(),
}));

import { runRefusal } from '@listen-fire/language-versions';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { anthropicChat } from '../../../../lib/anthropic';
import { resolveAdapter } from '../../adapters/resolve';
import { loadTriggerById } from '../../storage/tg_table';
import { runCatalogSnapshotForTeam } from '../catalog';
import { getMovementRow } from '../store';
import { runMovementTestRun } from '../test_run';

const ECHO_012 = 'function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual fire echo\n';

it('a test run of a pin no carried version runs is refused by the registry, with no model call and no introspection', async () => {
  jest.mocked(loadTriggerById).mockResolvedValue({ id: 'trigger-1', kind: 'manual', movementId: 'movement-1', credentialsId: null } as never);
  jest.mocked(getMovementRow).mockResolvedValue({ id: 'movement-1', source: ECHO_012, languageVersion: '0.13.0' } as never);
  const invent = jest.fn();

  const result = await runMovementTestRun({ teamId: 'team-1' as TeamId, triggerId: 'trigger-1', invent });

  expect(result).toEqual({ ok: false, error: runRefusal('0.13.0') });
  expect(invent).not.toHaveBeenCalled();
  expect(anthropicChat).not.toHaveBeenCalled();
  expect(resolveAdapter).not.toHaveBeenCalled();
  expect(runCatalogSnapshotForTeam).not.toHaveBeenCalled();
});

it("a 0.12 test run rehearses its manual listen on 0.12's own run host, from the live text, with no model call, introspection or catalog of this release", async () => {
  jest.mocked(loadTriggerById).mockResolvedValue({ id: 'trigger-1', kind: 'manual', movementId: 'movement-1', credentialsId: null } as never);
  jest.mocked(getMovementRow).mockResolvedValue({ id: 'movement-1', name: 'echo_file', source: ECHO_012, languageVersion: '0.12.13' } as never);
  const invent = jest.fn();
  const { runCarriedSegment } = jest.requireMock('../carried_run') as { runCarriedSegment: jest.Mock };

  const result = await runMovementTestRun({ teamId: 'team-1' as TeamId, triggerId: 'trigger-1', seed: 'a note', invent });

  expect(result).toMatchObject({ ok: true, writes: [], event: { text: 'a note' } });
  expect(runCarriedSegment).toHaveBeenCalledWith(
    expect.objectContaining({ pin: '0.12.13', movementName: 'echo', imports: 'live', dryRun: true, source: ECHO_012 }),
  );
  expect(invent).not.toHaveBeenCalled();
  expect(anthropicChat).not.toHaveBeenCalled();
  expect(resolveAdapter).not.toHaveBeenCalled();
  expect(runCatalogSnapshotForTeam).not.toHaveBeenCalled();
});
