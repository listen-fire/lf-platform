// A test run of an automation pinned to a version this build does not run is
// refused by the registry before anything reads the program: no introspection
// of the source system, no model inventing an event, no catalog assembled.

jest.mock('../../storage/tg_table', () => ({ loadTriggerById: jest.fn() }));
jest.mock('../store', () => ({ getMovementRow: jest.fn() }));
jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));
jest.mock('../../../../lib/anthropic', () => ({ anthropicChat: jest.fn() }));
jest.mock('../catalog', () => ({ runCatalogSnapshotForTeam: jest.fn() }));
jest.mock('../../../movement_engine/dispatch/dispatch', () => ({
  ...jest.requireActual('../../../movement_engine/dispatch/engine_choice'),
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

it.each(['0.13.0', '0.12.13'])('a test run of %s, which no carried version runs, is refused by the registry, with no model call and no introspection', async (pin) => {
  jest.mocked(loadTriggerById).mockResolvedValue({ id: 'trigger-1', kind: 'manual', movementId: 'movement-1', credentialsId: null } as never);
  jest.mocked(getMovementRow).mockResolvedValue({ id: 'movement-1', source: ECHO_012, languageVersion: pin } as never);
  const invent = jest.fn();

  const result = await runMovementTestRun({ audience: { for: 'run' }, teamId: 'team-1' as TeamId, triggerId: 'trigger-1', invent });

  expect(result).toEqual({ ok: false, error: runRefusal(pin) });
  expect(invent).not.toHaveBeenCalled();
  expect(anthropicChat).not.toHaveBeenCalled();
  expect(resolveAdapter).not.toHaveBeenCalled();
  expect(runCatalogSnapshotForTeam).not.toHaveBeenCalled();
});
