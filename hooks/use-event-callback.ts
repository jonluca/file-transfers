import { useCallback, useLayoutEffect, useRef } from "react";

// UI and native callbacks may outlive a render. Read the latest committed handler
// without changing the callback identity or exposing an uncommitted render.
export function useEventCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const callbackRef = useRef(callback);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
