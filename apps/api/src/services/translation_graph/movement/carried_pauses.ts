/** What a retired row's pause consists of: the run mode, the loop guard's
 *  hold and the loop breaker's hold are three separate records. */
export interface CarriedPause {
  off: boolean;
  guard?: { at: Date; reason: string | null; signal: string | null };
  breaker?: string;
}

function mergePauses(pauses: readonly CarriedPause[]): CarriedPause | null {
  if (pauses.length === 0) return null;
  const guard = pauses.find((pause) => pause.guard !== undefined)?.guard;
  const breaker = pauses.find((pause) => pause.breaker !== undefined)?.breaker;
  return { off: pauses.some((pause) => pause.off), ...(guard !== undefined ? { guard } : {}), ...(breaker !== undefined ? { breaker } : {}) };
}

/**
 * The pause each new listen takes from the rows an upgrade retires. A
 * row from before the upgrade carries no plan the new one can be compared to,
 * so a new listen is matched to the retired rows that fired the same movement
 * through the same module and credential: with as many of them as there are
 * new listens like it, each takes its own state; otherwise it cannot be said
 * which of them was paused, and the new listens keep the pause, since starting
 * what a person stopped is the worse mistake. A pause on a row no new listen
 * resembles passes to every new listen, for the same reason. `unsure` marks
 * the listens whose pause was kept on that reasoning, which the upgrade names.
 */
export function carriedPauses(input: {
  retired: ReadonlyArray<{ identity: string | null; pause: CarriedPause | null }>;
  fresh: ReadonlyArray<{ identity: string }>;
}): Array<{ pause: CarriedPause | null; unsure: boolean }> {
  const stray = mergePauses(
    input.retired
      .filter((row) => row.pause !== null && !input.fresh.some((fresh) => fresh.identity === row.identity))
      .map((row) => row.pause!),
  );
  return input.fresh.map(({ identity }) => {
    const predecessors = input.retired.filter((row) => row.identity === identity);
    const paused = predecessors.flatMap((row) => (row.pause === null ? [] : [row.pause]));
    const peers = input.fresh.filter((fresh) => fresh.identity === identity).length;
    const told = predecessors.length === peers && (paused.length === 0 || paused.length === predecessors.length);
    const pause = mergePauses([...paused, ...(stray === null ? [] : [stray])]);
    return { pause, unsure: pause !== null && (!told || stray !== null) };
  });
}

export const listenIdentityOf = (listen: { movementName: string | null; kind: string; credentialsId: string | null }): string | null =>
  listen.movementName === null ? null : `${listen.movementName}::${listen.kind}::${listen.credentialsId ?? ''}`;
