import { render, screen } from "@testing-library/react";
import { CitationHighlight } from "./CitationHighlight";
test("highlights exactly the cited span", () => {
  const rawText = "The Receiving Party shall keep it confidential for five years.";
  const span = { doc_id: "d1", char_start: 4, char_end: 18, quote: rawText.slice(4, 18) };
  render(<CitationHighlight rawText={rawText} span={span} />);
  const mark = screen.getByText(span.quote, { selector: "mark" });
  expect(mark.textContent).toBe(rawText.slice(4, 18));
});
