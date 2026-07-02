import { cn } from "./cn";

test("cn merges + de-dupes tailwind classes", () => {
  expect(cn("px-2", "px-4")).toBe("px-4");
  expect(cn("text-sm", false && "hidden", "font-medium")).toBe("text-sm font-medium");
});
