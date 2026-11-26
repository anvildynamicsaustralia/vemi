/**
 * Where this copy of VEMI keeps a person's data, in one of three general sentences. It names no
 * person. The local flag belongs to the local-mode phase; nothing sets it before then.
 */
export function dataHome({ owner, local = false }: { readonly owner: boolean; readonly local?: boolean }): string {
  if (local) return "Kept on this device only.";
  if (owner) return "This VEMI runs on your own Cloudflare space.";
  return "This VEMI is run by the person who invited you. Anything you don't lock is stored on their Cloudflare space.";
}
