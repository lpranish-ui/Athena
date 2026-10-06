import { useCallback, useEffect, useRef, useState } from 'react';

/** Use elapsed wall time so a suspended app does not shorten an exam duration. */
export function useQuizClock(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const durationRef = useRef(0);

  const getElapsed = useCallback(() => startedAtRef.current === null
    ? durationRef.current
    : Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)), []);

  useEffect(() => {
    if (!running) return;
    startedAtRef.current = Date.now();
    const timer = setInterval(() => setElapsed(getElapsed()), 1000);
    return () => {
      durationRef.current = getElapsed();
      startedAtRef.current = null;
      setElapsed(durationRef.current);
      clearInterval(timer);
    };
  }, [getElapsed, running]);

  const resetElapsed = useCallback(() => {
    startedAtRef.current = null;
    durationRef.current = 0;
    setElapsed(0);
  }, []);

  return { elapsed, getElapsed, resetElapsed };
}
