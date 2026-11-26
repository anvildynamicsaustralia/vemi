/**
 * What signing out costs, said before it happens. Changes waiting on this device belong to the
 * account signed in, and signing out is the person choosing to let them go, so it is said once,
 * plainly, with the count, and only when there is something to lose.
 */
export function discardsWaiting(waiting: number): string {
  return waiting === 1
    ? "1 change made on this device has not sent yet. Signing out discards it."
    : `${waiting} changes made on this device have not sent yet. Signing out discards them.`;
}
