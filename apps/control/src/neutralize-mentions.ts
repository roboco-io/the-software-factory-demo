/** Defuses @mentions and #references so agent-adjacent text cannot ping people or link issues. */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/@/g, "@​")
    .replace(/#(?=\d)/g, "#​")
    .replace(/[\r\n]+/g, " ");
}
