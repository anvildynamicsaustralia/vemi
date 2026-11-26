/**
 * The pre-filled Cloudflare token address. One button opens it; the person only presses create.
 * The permission keys are Cloudflare's short keys for an account-owned token template, taken
 * from the Task 1 notes (phases/notes_setup-helper.md, (a)). The three strings are unconfirmed
 * against production until a hand check opens the link, so they live here and nowhere else.
 */

/** The name the token is given on Cloudflare's page; the person sees it in their token list. */
export const TOKEN_NAME = "VEMI setup";

export interface TokenPermission {
  key: string;
  type: "read" | "edit";
}

/** The fewest permissions that cover every call the build makes. */
export const TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  { key: "workers_scripts", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "account_settings", type: "read" },
];

/** The dashboard. The `:account` in the link stays as written: Cloudflare asks which account when there are several. */
export const TOKEN_PAGE = "https://dash.cloudflare.com/";

export function tokenLink(): string {
  const keys = encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS));
  return `${TOKEN_PAGE}?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${encodeURIComponent(TOKEN_NAME)}`;
}
