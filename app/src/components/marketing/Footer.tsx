const GITHUB_URL = "https://github.com/koushikpb/sift";

const linkClass =
  "rounded-sm transition-colors hover:text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function Footer() {
  return (
    <footer className="border-t border-foreground/10 px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 text-sm text-muted sm:flex-row sm:justify-between">
        <p>Sift is a research prototype for NDA review — not legal advice.</p>
        <div className="flex items-center gap-6">
          <a href="#how" className={linkClass}>
            How it works
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={linkClass}>
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
