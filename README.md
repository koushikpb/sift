# sift

NDA review that shows its work. Point it at a contract, tell it what you care
about ("governing law", "return or destruction"), and it pulls the relevant
clause, checks it against a playbook, and explains what's off — quoting the
exact text it relied on. If it can't back an answer with a quote from the
document, it refuses instead of guessing.

**Try it:** [sift-app-iota.vercel.app](https://sift-app-iota.vercel.app) —
the first request after a quiet spell takes a few extra seconds while the
free-tier database wakes up.

<!-- demo GIF goes here -->

## What you get

- The clause itself, quoted verbatim with character offsets into the original
  document. That's a hard invariant: `quote === raw_text.slice(char_start, char_end)`
  has to hold exactly, and the tests fail if it drifts.
- A clause-type label from a Legal-BERT model fine-tuned with LoRA.
- A severity flag when the clause deviates from the playbook position, with a
  short rationale and suggested replacement wording where it falls short.
- An exportable review memo. It stays a preview until you click confirm —
  nothing gets written without a human saying so.

Refusals are a feature, not an error. Ask about something the document doesn't
cover and you get "insufficient context" instead of a confident hallucination.

## Numbers

Each piece had to earn its place on an eval before it shipped.

The fine-tuned classifier had to beat a few-shot llama-3.3-70b baseline by at
least +0.05 macro-F1 on the same 371-item CUAD subset, with the bar set before
the run:

|  | macro-F1 | accuracy |
|---|---|---|
| prompted 70B baseline | 0.666 | 0.744 |
| Legal-BERT + LoRA | **0.718** | **0.836** |

On the 50-item end-to-end review eval: groundedness 1.0 — zero hallucinated
citations across all 50 runs — and zero memo writes without confirmation.
Excluding runs where the free-tier LLM endpoint timed out before answering,
19/19 playbook deviations were flagged. Full reports are in `docs/eval-reports/`.

## Running it locally

You'll need Docker, Node 20, and Python 3.11.

```bash
cp .env.demo.example .env    # add an LLM key (any OpenAI-compatible endpoint works)
make db-up && make migrate
make ingest && make parse && make load
cd core && npm run embed && cd ..
make clf-precompute
npm -w @sift/app run dev     # http://localhost:3000
```

One honest caveat: the hosted demo retrieves with plain Postgres full-text
search, because the embedding model can't run inside a Vercel function.
Locally you get the full hybrid dense + lexical retrieval with reranking.

There's also an MCP server (`make mcp-serve`) if you'd rather drive the review
tools from Claude Desktop — see `docs/mcp-quickstart.md`.

Built on two public datasets, both CC BY 4.0:
[ContractNLI](https://stanfordnlp.github.io/contract-nli/) from Stanford NLP and
[CUAD](https://www.atticusprojectai.org/cuad) from The Atticus Project.

Not legal advice. It drafts, a human decides.
