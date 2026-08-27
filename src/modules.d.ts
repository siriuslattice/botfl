// Text modules bundled via the wrangler.toml "Text" rule.
declare module '*.csv' {
  const text: string;
  export default text;
}

declare module '*.md' {
  const text: string;
  export default text;
}
