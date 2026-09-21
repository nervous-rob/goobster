/** Shape validation only; invitation APIs check whether the account is eligible. */
export function pastedPrincipalId(value: string): string | null {
    return /^(?:\d{5,20}|usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value)
        ? value
        : null;
}
