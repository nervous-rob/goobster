import type { ReactNode } from 'react';

interface LabShellProps {
  title: string;
  badge?: string;
  subtitle: string;
  icon?: ReactNode;
  children: ReactNode;
}

/** Shared page chrome matching the rhythm/harmony engine shell. */
export function LabShell({ title, badge, subtitle, icon, children }: LabShellProps) {
  return (
    <section className="rhythm-engine">
      <header className="re-header">
        <div className="re-brand">
          {icon ? <span className="re-brand-icon">{icon}</span> : null}
          <div>
            <h2 className="re-title">
              {title}
              {badge ? <> <span className="re-accent-text">{badge}</span></> : null}
            </h2>
            <p className="re-subtitle">{subtitle}</p>
          </div>
        </div>
      </header>
      {children}
    </section>
  );
}
