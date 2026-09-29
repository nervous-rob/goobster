import { berryIconSrc, usePaintedAccent } from '../lib/berry';

/** The Goobster mark, in whichever accent the page is painted. Decorative. */
export function BerryMark({ className, size }: { className?: string; size: number }) {
    const accent = usePaintedAccent();
    return <img className={className} src={berryIconSrc(accent)} alt="" width={size} height={size} />;
}
