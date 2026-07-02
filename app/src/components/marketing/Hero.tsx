import Link from "next/link";
import { Button } from "../ui/Button";

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pb-24 pt-28 sm:pb-32 sm:pt-36">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <p className="mb-6 inline-flex items-center rounded-full border border-foreground/10 bg-foreground/5 px-4 py-1.5 text-xs font-medium tracking-wide text-muted">
          NDA review, grounded in the source
        </p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl md:text-6xl">
          Contract review that cites its sources
          <span className="block text-accent">or says it can&rsquo;t.</span>
        </h1>
        <p className="mt-6 max-w-xl text-balance text-lg leading-relaxed text-muted">
          sift reads an NDA, flags clauses against a playbook, and drafts redlines — every
          claim backed by an exact cited span from the document. When it can&rsquo;t ground an
          answer, it refuses instead of guessing.
        </p>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/review">Try the demo</Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <a href="#how">See how it works</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
