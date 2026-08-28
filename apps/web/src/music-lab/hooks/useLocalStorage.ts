import { useCallback, useEffect, useState } from 'react';
import { conservatoryStorageKey } from '@music-lab/lib/storage';

const isBrowser = typeof window !== 'undefined';

export function useLocalStorage<T>(key: string, defaultValue: T) {
  const storedKey = conservatoryStorageKey(key);
  const [value, setValue] = useState<T>(() => {
    if (!isBrowser) {
      return defaultValue;
    }
    try {
      const stored = window.localStorage.getItem(storedKey);
      if (stored === null) {
        return defaultValue;
      }
      return JSON.parse(stored) as T;
    } catch (err) {
      console.warn('Unable to read localStorage key', storedKey, err);
      return defaultValue;
    }
  });

  useEffect(() => {
    if (!isBrowser) {
      return;
    }
    try {
      window.localStorage.setItem(storedKey, JSON.stringify(value));
    } catch (err) {
      console.warn('Unable to write localStorage key', storedKey, err);
    }
  }, [storedKey, value]);

  const updateValue = useCallback(
    (updater: T | ((prev: T) => T)) => {
      setValue(prev => (typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater));
    },
    []
  );

  return [value, updateValue] as const;
}
