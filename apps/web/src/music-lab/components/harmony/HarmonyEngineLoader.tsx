import { lazy, Suspense } from 'react';

const HarmonyEngine = lazy(() => import('./HarmonyEngine').then((mod) => ({ default: mod.HarmonyEngine })));

export function HarmonyEngineLoader() {
  return (
    <Suspense
      fallback={(
        <section className="rhythm-engine harmony-engine re-loading">
          <p className="re-subtitle">Charging the gravity field…</p>
        </section>
      )}
    >
      <HarmonyEngine />
    </Suspense>
  );
}
