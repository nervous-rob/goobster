import { lazy, Suspense } from 'react';

const MelodyEngine = lazy(() => import('./MelodyEngine').then((mod) => ({ default: mod.MelodyEngine })));

export function MelodyEngineLoader() {
  return (
    <Suspense
      fallback={(
        <section className="rhythm-engine stage-engine re-loading">
          <p className="re-subtitle">Warming the hatchery…</p>
        </section>
      )}
    >
      <MelodyEngine />
    </Suspense>
  );
}
