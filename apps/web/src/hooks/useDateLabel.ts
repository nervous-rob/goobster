import { useUserSettings } from './useUserSettings';

/** Display preferences never change stored UTC timestamps. */
export function useDateLabel(timeOnly = false) {
    const { data } = useUserSettings();
    const prefs = data?.sections.profile.values;
    return (stamp?: string | null): string => {
        if (!stamp) return '';
        const date = new Date(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
        if (Number.isNaN(date.getTime())) return stamp;
        return new Intl.DateTimeFormat(prefs?.dateLocale || undefined, {
            ...(timeOnly ? {} : { month: 'short', day: 'numeric' }),
            hour: '2-digit', minute: '2-digit',
            ...(prefs?.timezone ? { timeZone: prefs.timezone } : {}),
            ...(prefs?.timeFormat === '12' ? { hour12: true } : prefs?.timeFormat === '24' ? { hour12: false } : {})
        }).format(date);
    };
}
