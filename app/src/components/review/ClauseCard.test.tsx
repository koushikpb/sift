import { render, screen } from "@testing-library/react";
import { ClauseCard } from "./ClauseCard";
import type { ClauseCardProps } from "./ClauseCard";

const baseProps: ClauseCardProps = {
  objective: "What is the confidentiality term?",
  citation: null,
  classification: null,
  flag: null,
  redline: null,
  refused: false,
  refusal_reason: null,
};

describe("ClauseCard", () => {
  it("renders a refusal via RefusalNotice, not an error", () => {
    render(
      <ClauseCard
        {...baseProps}
        refused={true}
        refusal_reason="The objective concerns arbitration, which this playbook does not cover."
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Insufficient context to review this objective");
    expect(screen.getByText(/arbitration/)).toBeInTheDocument();
    expect(screen.queryByText(/No source text found/)).not.toBeInTheDocument();
  });

  it("renders a grounded deviation with citation highlight, severity badge, and redline", () => {
    const quote = "This Agreement shall remain in effect in perpetuity.";
    render(
      <ClauseCard
        {...baseProps}
        citation={{ doc_id: "contractnli_4", char_start: 100, char_end: 100 + quote.length, quote }}
        classification={{ clause_type: "Term / Duration of Confidentiality", score: 0.93 }}
        flag={{
          playbook_id: "confidentiality_term",
          clause_type: "Term / Duration of Confidentiality",
          severity: "high",
          deviation: true,
          rationale: "Perpetual term exceeds the 3-5 year standard position.",
          citation: { doc_id: "contractnli_4", char_start: 100, char_end: 100 + quote.length, quote },
        }}
        redline={{
          playbook_id: "confidentiality_term",
          original: { doc_id: "contractnli_4", char_start: 100, char_end: 100 + quote.length, quote },
          suggested_text: "This Agreement shall remain in effect for five (5) years.",
          rationale: "Brings the term within the playbook's standard 3-5 year range.",
        }}
      />,
    );

    const mark = screen.getByText(quote, { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(screen.getByText(/High severity/)).toBeInTheDocument();
    expect(screen.getByText("Term / Duration of Confidentiality")).toBeInTheDocument();
    expect(screen.getByText(/five \(5\) years/)).toBeInTheDocument();
  });

  it("renders a grounded clause with no playbook match (no severity badge, no redline)", () => {
    const quote = "Notices shall be delivered by certified mail.";
    render(
      <ClauseCard
        {...baseProps}
        citation={{ doc_id: "contractnli_1", char_start: 0, char_end: quote.length, quote }}
        classification={{ clause_type: "Notices", score: 0.71 }}
      />,
    );
    expect(screen.getByText(quote, { selector: "mark" })).toBeInTheDocument();
    expect(screen.queryByText(/severity/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Suggested redline/)).not.toBeInTheDocument();
  });

  it("renders a missing-required-clause finding when the citation is null", () => {
    render(
      <ClauseCard
        {...baseProps}
        flag={{
          playbook_id: "return_of_materials",
          clause_type: "Return or Destruction",
          severity: "low",
          deviation: true,
          rationale: "required clause appears absent (not found in contract)",
          citation: null,
        }}
      />,
    );
    expect(screen.getByText(/No source text found/)).toBeInTheDocument();
    expect(screen.getByText(/Low severity/)).toBeInTheDocument();
    expect(screen.queryByRole("mark")).not.toBeInTheDocument();
  });

  it("renders a compliant match distinctly from a deviation", () => {
    const quote = "Obligations survive for a period of four (4) years from disclosure.";
    render(
      <ClauseCard
        {...baseProps}
        citation={{ doc_id: "contractnli_6", char_start: 0, char_end: quote.length, quote }}
        classification={{ clause_type: "Term / Duration of Confidentiality", score: 0.88 }}
        flag={{
          playbook_id: "confidentiality_term",
          clause_type: "Term / Duration of Confidentiality",
          severity: "high",
          deviation: false,
          rationale: "Four-year term falls within the standard 3-5 year position.",
          citation: { doc_id: "contractnli_6", char_start: 0, char_end: quote.length, quote },
        }}
      />,
    );
    expect(screen.getByText("Meets playbook standard")).toBeInTheDocument();
    expect(screen.queryByText(/deviation/)).not.toBeInTheDocument();
  });
});
