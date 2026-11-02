import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('actor gate — router wiring pin', () => {
  const routerSrc = readFileSync(join(__dirname, '../router.ts'), 'utf-8');
  it('the router consults the gate and drops the run naming why', () => {
    expect(routerSrc).toMatch(/consultActorGate/);
    expect(routerSrc).toMatch(/'actor_unregistered'/);
  });
});
