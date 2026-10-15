// Minimal Python syntax colouring: one regex pass, HTML out.
const KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except finally for from '
  + 'global if import in is lambda nonlocal not or pass raise return try while with yield match case').split(' '));
const BUILTINS = new Set(('abs all any bool complex dict divmod enumerate filter float format getattr hasattr int isinstance len list '
  + 'map max min next print range repr reversed round set sorted str sum tuple type zip u Q units').split(' '));

const TOKEN = /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|[rbfuRBFU]{0,2}"(?:[^"\\\n]|\\.)*"?|[rbfuRBFU]{0,2}'(?:[^'\\\n]|\\.)*'?)|(#[^\n]*)|(\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?j?\b|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_À-￿][\wÀ-￿]*)|(@[\w.]+)/g;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightPython(code: string): string {
  let out = '';
  let last = 0;
  let prev = '';
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(code); m; m = TOKEN.exec(code)) {
    out += esc(code.slice(last, m.index));
    last = m.index + m[0].length;
    const t = m[0];
    let cls = '';
    if (m[1]) cls = 'str';
    else if (m[2]) cls = 'com';
    else if (m[3]) cls = 'num';
    else if (m[5]) cls = 'dec';
    else if (m[4]) {
      if (KEYWORDS.has(t)) cls = 'kw';
      else if (prev === 'def' || prev === 'class') cls = 'def';
      else if (BUILTINS.has(t)) cls = 'bi';
      prev = t;
    }
    out += cls ? `<span class="py-${cls}">${esc(t)}</span>` : esc(t);
  }
  return out + esc(code.slice(last));
}
