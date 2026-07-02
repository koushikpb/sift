import { Nav } from "../src/components/marketing/Nav";
import { Hero } from "../src/components/marketing/Hero";
import { Features } from "../src/components/marketing/Features";
import { HowItWorks } from "../src/components/marketing/HowItWorks";
import { Footer } from "../src/components/marketing/Footer";

export default function Page() {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-6 focus:top-6 focus:z-[60] focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-background"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main-content">
        <Hero />
        <Features />
        <HowItWorks />
      </main>
      <Footer />
    </>
  );
}
