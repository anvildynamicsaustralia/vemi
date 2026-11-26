// VEMI-013 project phase: the repo row shows when a GitHub repo was last pushed to.
// Everything here fails quietly. A private repo, an offline phone or a blocked store
// means the row shows the link only.

export interface Repo {
  readonly owner: string;
  readonly name: string;
  readonly url: string;
}

export interface RepoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type RepoFetcher = (url: string) => Promise<Response>;

const CACHE_MS = 15 * 60_000;
const PART = /^[A-Za-z0-9_.-]+$/;

/** Reads `owner/name` or a github.com URL. Anything else is null. */
export function parseRepo(input: string): Repo | null {
  let text = input.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (/^github\.com\//i.test(text)) text = text.slice("github.com/".length);
  else if (/^[^/\s]+\.[^/\s]+\//.test(text)) return null;
  const parts = text.split("/");
  const owner = parts[0] ?? "";
  const name = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!PART.test(owner) || !PART.test(name)) return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

const keyOf = (repo: Repo) => `vemi.repo.push.${repo.owner}/${repo.name}`.toLowerCase();

function cached(repo: Repo, storage: RepoStorage, now: number): string | null {
  try {
    const raw = storage.getItem(keyOf(repo));
    if (!raw) return null;
    const hit = JSON.parse(raw) as { at?: unknown; pushedAt?: unknown };
    if (typeof hit.at !== "number" || typeof hit.pushedAt !== "string") return null;
    return now >= hit.at && now - hit.at < CACHE_MS ? hit.pushedAt : null;
  } catch {
    return null;
  }
}

/** `lastPush`, except that a copy kept in the page (`local`) asks GitHub nothing. */
export async function lastPushHere(
  repo: Repo,
  fetcher: RepoFetcher,
  storage: RepoStorage,
  local: boolean,
): Promise<string | null> {
  return local ? null : lastPush(repo, fetcher, storage);
}

/** The repo's last push as an ISO string, or null. Never throws. */
export async function lastPush(
  repo: Repo,
  fetcher: RepoFetcher,
  storage: RepoStorage,
  now: number = Date.now(),
): Promise<string | null> {
  const hit = cached(repo, storage, now);
  if (hit) return hit;
  try {
    const res = await fetcher(`https://api.github.com/repos/${repo.owner}/${repo.name}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { pushed_at?: unknown };
    if (typeof body.pushed_at !== "string" || body.pushed_at === "") return null;
    try {
      storage.setItem(keyOf(repo), JSON.stringify({ at: now, pushedAt: body.pushed_at }));
    } catch {
      // A blocked store only costs the cache.
    }
    return body.pushed_at;
  } catch {
    return null;
  }
}
