import { useEffect, useState, type DependencyList } from "react";
import { liveQuery } from "dexie";

/** Minimal `dexie-react-hooks`-style subscription, without adding the package. */
export function useLiveQuery<T>(querier: () => Promise<T> | T, deps: DependencyList = []): T | undefined {
  const [value, setValue] = useState<T>();

  useEffect(() => {
    const subscription = liveQuery(querier).subscribe({
      next: setValue,
      error: (err: unknown) => console.error("useLiveQuery", err),
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
