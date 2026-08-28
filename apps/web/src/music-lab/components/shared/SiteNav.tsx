import { Link, useRouterState } from '@tanstack/react-router';
import { conservatoryPath, isConservatoryPath } from '@music-lab/lib/paths';

const NAV_ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/intervals', label: 'Intervals' },
  { href: '/chords', label: 'Chords' },
  { href: '/rhythm', label: 'Rhythm' },
  { href: '/harmony', label: 'Harmony' },
  { href: '/space', label: 'Space' },
  { href: '/melody', label: 'Melody' },
  { href: '/stage', label: 'Stage' },
  { href: '/studio', label: 'Studio' }
] as const;

export function SiteNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="site-nav engine-switch" aria-label="Conservatory sections">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          to={conservatoryPath(item.href) as never}
          className={`engine-switch-btn${isConservatoryPath(pathname, item.href) ? ' on' : ''}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
