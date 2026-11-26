/**
 * The VEMI wordmark, from `brand/vemi-wordmark.svg`, drawn in the colour of the text around it
 * so the dark panel and a light page can both use it. It is a mask over the text colour: the
 * picture is a file the page asks for like any other asset (the page's policy already allows
 * its own images), not code in the first download.
 */
export function Wordmark({ className }: { readonly className?: string }) {
  return <span className={className === undefined ? "wordmark" : `wordmark ${className}`} role="img" aria-label="VEMI" />;
}
