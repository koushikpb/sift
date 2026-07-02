type Step = {
  n: string;
  title: string;
  body: string;
};

const steps: Step[] = [
  {
    n: "01",
    title: "Every claim is grounded",
    body: "Each answer carries a citation — { doc_id, char_start, char_end, quote } — pointing at the exact span in the source contract. The quote is the literal text at that span, not a paraphrase.",
  },
  {
    n: "02",
    title: "Insufficient context? It refuses.",
    body: "When retrieval can't support an answer, sift says so instead of guessing. “Insufficient context” is a correct answer, not a failure.",
  },
  {
    n: "03",
    title: "You confirm before anything happens",
    body: "The action agent can draft a redline or prepare a memo export, but nothing destructive or external happens without your explicit confirmation.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-heading" className="border-t border-foreground/10 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <h2 id="how-heading" className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            How it works
          </h2>
          <p className="mt-4 text-balance text-muted">Three invariants sift never breaks.</p>
        </div>
        <ol className="mt-16 grid grid-cols-1 gap-10 md:grid-cols-3">
          {steps.map((step) => (
            <li key={step.n} className="flex flex-col gap-3">
              <span className="text-sm font-medium text-accent">{step.n}</span>
              <h3 className="text-lg font-medium text-foreground">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
