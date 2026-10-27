// Intentionally vulnerable fixture: raw HTML from props reaches the DOM.
export function Bio({ html }: { html: string }) {
  return <div className="bio" dangerouslySetInnerHTML={{ __html: html }} />;
}
