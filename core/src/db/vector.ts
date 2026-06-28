/** Format a numeric vector as a pgvector literal: '[v1,v2,...]'. Use with `$n::vector`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
