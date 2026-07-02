import type { ReactElement, SVGProps } from "react";

function QuoteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 8.25h-3a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5H6a1.5 1.5 0 0 1 1.5 1.5v.75a2.25 2.25 0 0 1-2.25 2.25H4.5M18 8.25h-3a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5h1.5a1.5 1.5 0 0 1 1.5 1.5v.75a2.25 2.25 0 0 1-2.25 2.25H15"
      />
    </svg>
  );
}

function TagIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.169.659 1.591l9.581 9.581a2.25 2.25 0 0 0 3.182 0l4.318-4.318a2.25 2.25 0 0 0 0-3.182L10.16 3.66A2.25 2.25 0 0 0 8.568 3Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6Z" />
    </svg>
  );
}

function ShieldCheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75M12 3c2.25 2 4.5 2.25 6.75 2.25 0 8.25-3.75 12-6.75 13.5-3-1.5-6.75-5.25-6.75-13.5C7.5 5.25 9.75 5 12 3Z"
      />
    </svg>
  );
}

type Feature = {
  title: string;
  description: string;
  icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
};

const features: Feature[] = [
  {
    title: "Grounded RAG, cited by exact span",
    description:
      "Every answer is retrieved from the contract itself and cited to the exact source span — document, character range, and quote. If retrieval can't support an answer, sift refuses rather than guessing.",
    icon: QuoteIcon,
  },
  {
    title: "Fine-tuned clause classifier",
    description:
      "Clauses are labeled by a LoRA fine-tuned classifier trained on labeled contract data, not a generic prompt — built for this document type: NDAs.",
    icon: TagIcon,
  },
  {
    title: "Action agent, human-in-the-loop",
    description:
      "Drafts redlines and prepares a review memo — nothing leaves the review until you give an explicit confirmation.",
    icon: ShieldCheckIcon,
  },
];

export function Features() {
  return (
    <section aria-labelledby="features-heading" className="px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <h2 id="features-heading" className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Three layers, one grounded review
          </h2>
          <p className="mt-4 text-balance text-muted">
            Built for NDA review — not a generic chat-over-PDF wrapper.
          </p>
        </div>
        <div className="mt-16 grid grid-cols-1 gap-6 md:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-8">
              <feature.icon className="h-6 w-6 text-accent" />
              <h3 className="mt-5 text-lg font-medium text-foreground">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
