export interface Candidate {
  node_id: string;
  doc_id: string;
  type: string;
  number: string | null;
  heading: string | null;
  text: string;
  char_start: number;
  char_end: number;
  score: number;
}
