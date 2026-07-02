"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/cn";

type ButtonVariant = "primary" | "secondary";
type ButtonSize = "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Render as the single child element (e.g. a `next/link` `<Link>`) instead of a `<button>`. */
  asChild?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium " +
  "transition-colors duration-200 cursor-pointer " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  // Dark accent fill; text uses --background (near-black) rather than white — the
  // contrast for the accent token against white falls short of AA (4.10:1),
  // against background it clears it (4.74:1).
  primary: "bg-accent text-background hover:bg-accent/90",
  secondary: "border border-foreground/15 text-foreground hover:bg-foreground/5",
};

const sizes: Record<ButtonSize, string> = {
  md: "h-11 px-5 text-sm", // 44px min touch target
  lg: "h-12 px-7 text-base",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
