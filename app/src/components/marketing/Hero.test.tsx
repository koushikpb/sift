import { render, screen } from "@testing-library/react";
import { Hero } from "./Hero";
test("hero shows the value prop and a CTA into the demo", () => {
  render(<Hero />);
  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /try the demo/i })).toHaveAttribute("href", "/review");
});
