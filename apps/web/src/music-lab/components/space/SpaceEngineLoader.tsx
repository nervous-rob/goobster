import { lazy, Suspense } from 'react';

const SpaceEngine = lazy(() => import('./SpaceEngine').then((mod) => ({ default: mod.SpaceEngine })));

export function SpaceEngineLoader() {
  return (
    <Suspense
      fallback={(
        <section className="rhythm-engine space-engine re-loading">
          <p className="re-subtitle">Mapping the constellation…</p>
        </section>
      )}
    >
      <SpaceEngine />
    </Suspense>
  );
}
