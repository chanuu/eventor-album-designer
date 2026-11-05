import { useCallback, useState } from 'react';

/** Enough to back out of a long session without holding on to memory forever. */
const MAX_STEPS = 100;

type State<T> = {
  past: T[];
  present: T;
  future: T[];
  /** Consecutive changes with the same key count as one undo step. */
  mergeKey: string | null;
};

/** Undo and redo for one value. Kept pure, because React may run an update twice. */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState<State<T>>({
    past: [],
    present: initial,
    future: [],
    mergeKey: null,
  });

  const set = useCallback((change: (value: T) => T, mergeKey?: string) => {
    setState((s) => {
      const next = change(s.present);
      if (next === s.present) return s;
      if (mergeKey !== undefined && mergeKey === s.mergeKey) {
        return { ...s, present: next, future: [] };
      }
      return {
        past: [...s.past, s.present].slice(-MAX_STEPS),
        present: next,
        future: [],
        mergeKey: mergeKey ?? null,
      };
    });
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const previous = s.past[s.past.length - 1];
      if (previous === undefined) return s;
      return {
        past: s.past.slice(0, -1),
        present: previous,
        future: [s.present, ...s.future],
        mergeKey: null,
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const [next, ...rest] = s.future;
      if (next === undefined) return s;
      return { past: [...s.past, s.present], present: next, future: rest, mergeKey: null };
    });
  }, []);

  /** Ends the current merged step, so the next drag gets its own undo. */
  const seal = useCallback(() => {
    setState((s) => (s.mergeKey === null ? s : { ...s, mergeKey: null }));
  }, []);

  return {
    present: state.present,
    set,
    undo,
    redo,
    seal,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
