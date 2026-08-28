import { lazy, Suspense } from 'react';

const StudioEngine = lazy(() => import('./StudioEngine').then((mod) => ({ default: mod.StudioEngine })));

export function StudioEngineLoader() {
  return (
    <Suspense
      fallback={(
        <section className="rhythm-engine stage-engine studio-engine re-loading">
          <p className="re-subtitle">Booting the studio…</p>
        </section>
      )}
    >
      <StudioEngine />
    </Suspense>
  );
}
