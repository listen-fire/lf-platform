/** Thrown by a handler whose work cannot happen yet (the run it would step is
 *  held by another process): the row is released to retry with backoff, not
 *  completed, and the pass is not marked failing. */
export class WorkDeferred extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WorkDeferred';
  }
}
