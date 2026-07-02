import Link from "next/link";
import type { SVGProps } from "react";
import { Button } from "../ui/Button";

const GITHUB_URL = "https://github.com/koushikpb/sift";

function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.09 3.29 9.4 7.86 10.93.57.1.79-.25.79-.55 0-.27-.01-1.15-.02-2.09-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.64 1.59.24 2.76.12 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.07.78 2.16 0 1.56-.01 2.82-.01 3.2 0 .31.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

const linkClass =
  "text-sm text-muted transition-colors hover:text-foreground rounded-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-foreground/10 bg-background/80 backdrop-blur">
      <nav aria-label="Primary" className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className={`text-base font-semibold tracking-tight text-foreground ${linkClass}`}
        >
          sift
        </Link>
        <div className="flex items-center gap-6">
          <a href="#how" className={`hidden md:inline-block ${linkClass}`}>
            How it works
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className={`hidden items-center gap-1.5 md:inline-flex ${linkClass}`}
          >
            <GitHubIcon className="h-4 w-4" />
            GitHub
          </a>
          <Button asChild size="md">
            <Link href="/review">Try the demo</Link>
          </Button>
        </div>
      </nav>
    </header>
  );
}
