import { lazy, Suspense } from 'react';

const StageEngine = lazy(() => import('./StageEngine').then((mod) => ({ default: mod.StageEngine })));

export function StageEngineLoader() {
  return (
    <Suspense
      fallback={(
        <section className="rhythm-engine stage-engine re-loading">
          <p className="re-subtitle">Setting the stage…</p>
        </section>
      )}
    >
      <StageEngine />
    </Suspense>
  );
}
