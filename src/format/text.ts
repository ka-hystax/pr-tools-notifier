export function htmlToText(html: string): string {
  return html
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (_, quoted: string) => `│ ${quoted}`)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
