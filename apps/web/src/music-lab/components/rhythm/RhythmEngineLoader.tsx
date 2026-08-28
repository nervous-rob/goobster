import { lazy, Suspense } from 'react';

const RhythmEngine = lazy(() => import('./RhythmEngine').then((mod) => ({ default: mod.RhythmEngine })));

export function RhythmEngineLoader() {
  return (
    <Suspense
      fallback={(
        <section className="rhythm-engine re-loading">
          <p className="re-subtitle">Warming up the engine…</p>
        </section>
      )}
    >
      <RhythmEngine />
    </Suspense>
  );
}
