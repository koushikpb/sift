import type { Candidate } from "../retrieve/retrieve.js";

export interface GenInput {
  objective: string;
  candidates: Candidate[];
}

export interface RawGen {
  answer: string;
  supporting: number[];
  refused: boolean;
  refusal_reason?: string | null;
}

export interface Generator {
  generate(input: GenInput): Promise<RawGen>;
}
