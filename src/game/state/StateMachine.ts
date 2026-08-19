/**
 * A small explicit finite state machine.
 *
 * The point is not ceremony — it is that the legal states and the legal moves
 * between them are written down as data instead of implied by a scatter of
 * booleans. Code that tracks lifecycle with `isConnecting`, `hasStarted`,
 * `alreadyNotified` encodes its real states in the *combinations* of those
 * flags, including the combinations nobody meant to allow. Bugs there look
 * like "it fired twice", "it ran after teardown", "it went back to a state it
 * had already left" — all of which are simply transitions no one declared and
 * nothing rejected.
 *
 * So: declare the states, declare which event moves which state where, and
 * let everything undeclared be refused. An event that is not legal in the
 * current state is a no-op that returns false, never a corrupted state. That
 * makes "can this happen twice?" answerable by reading the table rather than
 * by auditing every caller.
 *
 * Deliberately tiny: no hierarchy, no parallel regions, no async. Anything
 * needing those is better off as several machines that observe each other.
 */

/** Which state each event leads to, per state. Omitted event = not legal. */
export type StateMachineTransitions<TState extends string, TEvent extends string> = {
  readonly [state in TState]: { readonly [event in TEvent]?: TState };
};

export type StateMachineDefinition<TState extends string, TEvent extends string> = {
  readonly initial: TState;
  readonly transitions: StateMachineTransitions<TState, TEvent>;
  /** Called after every accepted transition. Use for side effects that
   *  belong to the edge rather than to a state. */
  readonly onTransition?: (change: StateMachineChange<TState, TEvent>) => void;
  /** Name used in diagnostics. */
  readonly name?: string;
};

export type StateMachineChange<TState extends string, TEvent extends string> = {
  readonly from: TState;
  readonly to: TState;
  readonly event: TEvent;
};

export class StateMachine<TState extends string, TEvent extends string> {
  private current: TState;

  constructor(private readonly definition: StateMachineDefinition<TState, TEvent>) {
    this.current = definition.initial;
  }

  get state(): TState {
    return this.current;
  }

  is(...states: readonly TState[]): boolean {
    for (const state of states) {
      if (this.current === state) return true;
    }
    return false;
  }

  /** Whether `event` is legal right now. Lets callers skip work they would
   *  only throw away, without duplicating the transition table. */
  can(event: TEvent): boolean {
    return this.definition.transitions[this.current][event] !== undefined;
  }

  /**
   * Apply an event.
   *
   * Returns true if it caused a transition, false if the event is not legal
   * in the current state. False is a normal answer, not an error: "the host
   * left" arriving twice, or a countdown finishing after the player already
   * clicked through, are ordinary races. Refusing them here is exactly what
   * stops the caller from having to latch every path itself.
   */
  send(event: TEvent): boolean {
    const next = this.definition.transitions[this.current][event];
    if (next === undefined) return false;
    const from = this.current;
    this.current = next;
    this.definition.onTransition?.({ from, to: next, event });
    return true;
  }

  /** Back to the initial state, without running transition hooks — a reset
   *  is the machine being rebuilt, not an edge being travelled. */
  reset(): void {
    this.current = this.definition.initial;
  }

  toString(): string {
    return `${this.definition.name ?? 'StateMachine'}(${this.current})`;
  }
}

/** Convenience for the common `new StateMachine({...})` call. */
export function createStateMachine<TState extends string, TEvent extends string>(
  definition: StateMachineDefinition<TState, TEvent>,
): StateMachine<TState, TEvent> {
  return new StateMachine(definition);
}
