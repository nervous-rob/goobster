import { Link } from '@tanstack/react-router';
import { conservatoryPath } from '@music-lab/lib/paths';

/** Top-level mode switch shared by the engine pages: Rhythm | Harmony | Melody. */
export function EngineSwitch({ active }: { active: 'rhythm' | 'harmony' | 'melody' }) {
  return (
    <div className="engine-switch" role="navigation" aria-label="Engine selector">
      <Link to={conservatoryPath('/rhythm') as never} className={`engine-switch-btn${active === 'rhythm' ? ' on' : ''}`}>
        Rhythm Engine
      </Link>
      <Link to={conservatoryPath('/harmony') as never} className={`engine-switch-btn${active === 'harmony' ? ' on' : ''}`}>
        Harmony Engine
      </Link>
      <Link to={conservatoryPath('/melody') as never} className={`engine-switch-btn${active === 'melody' ? ' on' : ''}`}>
        Melody Engine
      </Link>
    </div>
  );
}
