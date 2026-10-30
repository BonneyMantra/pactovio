/** Minimal namespace-agnostic XML parser for OOXML parts (no DOM exists in Workers). Local names only. */
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text?: string;
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()] ?? '';
  });
}

const local = (n: string) => n.slice(n.indexOf(':') + 1);

export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(src))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.children.push({ name: '#text', attrs: {}, children: [], text: m[1] });
    else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      ATTR.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTR.exec(m[4] ?? ''))) attrs[local(a[1]!)] = decodeEntities(a[2] ?? a[3] ?? '');
      const node: XNode = { name: local(m[3]), attrs, children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.children.push({ name: '#text', attrs: {}, children: [], text: decodeEntities(m[6]) });
  }
  return root;
}

export const child = (n: XNode, name: string): XNode | undefined => n.children.find((c) => c.name === name);
export const kids = (n: XNode, name: string): XNode[] => n.children.filter((c) => c.name === name);
export const textOf = (n: XNode): string => (n.name === '#text' ? (n.text ?? '') : n.children.map(textOf).join(''));
export function find(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    find(c, name, out);
  }
  return out;
}
