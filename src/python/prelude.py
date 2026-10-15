# Runs once when Python starts. Provides units (u, Q, Quantity) to worksheet code and
# the bridge the worksheet uses to pass values in and out (_run, _call_py, _reset).
# Names starting with "_" are never exported back to the worksheet.
import contextlib as _contextlib
import io as _io
import json as _json
import math as _math
import re as _re
import traceback as _traceback
import types as _types
import inspect as _inspect
import ast as _ast

_DIM_NAMES = ('kg', 'm', 's', 'A', 'K', 'mol', 'cd')
_ZERO = (0, 0, 0, 0, 0, 0, 0)


def _clean_dim(d):
    out = []
    for x in d:
        r = round(x)
        out.append(int(r) if abs(x - r) < 1e-9 else x)
    return tuple(out)


def _q(si, dim):
    dim = _clean_dim(dim)
    return si if dim == _ZERO else Quantity(si, dim)


def _is_num(x):
    return isinstance(x, (int, float, complex)) and not isinstance(x, bool) or hasattr(x, 'dtype')


def _is_zero(x):
    try:
        return not isinstance(x, Quantity) and _is_num(x) and not hasattr(x, 'shape') and x == 0
    except Exception:
        return False


# Named SI units shown when printing a quantity (dimension → symbol)
_NAMED = {
    (0, 1, 0, 0, 0, 0, 0): 'm', (0, 2, 0, 0, 0, 0, 0): 'm²', (0, 3, 0, 0, 0, 0, 0): 'm³', (0, 4, 0, 0, 0, 0, 0): 'm⁴',
    (1, 0, 0, 0, 0, 0, 0): 'kg', (0, 0, 1, 0, 0, 0, 0): 's', (0, 0, -1, 0, 0, 0, 0): 'Hz',
    (1, 1, -2, 0, 0, 0, 0): 'N', (1, 0, -2, 0, 0, 0, 0): 'N/m', (1, -1, -2, 0, 0, 0, 0): 'Pa',
    (1, 2, -2, 0, 0, 0, 0): 'N·m', (1, 2, -3, 0, 0, 0, 0): 'W', (0, 1, -1, 0, 0, 0, 0): 'm/s',
    (0, 1, -2, 0, 0, 0, 0): 'm/s²', (1, -3, 0, 0, 0, 0, 0): 'kg/m³', (1, -1, 0, 0, 0, 0, 0): 'kg/m',
    (1, -2, -2, 0, 0, 0, 0): 'N/m³', (0, 0, 0, 1, 0, 0, 0): 'A', (1, 2, -3, -1, 0, 0, 0): 'V',
    (1, 2, -3, -2, 0, 0, 0): 'Ω', (0, 0, 1, 1, 0, 0, 0): 'C', (0, 0, 0, 0, 1, 0, 0): 'K',
    (0, 0, 0, 0, 0, 1, 0): 'mol', (0, 0, 0, 0, 0, 0, 1): 'cd', (0, 3, -1, 0, 0, 0, 0): 'm³/s',
}
_SUP = str.maketrans('-0123456789.', '⁻⁰¹²³⁴⁵⁶⁷⁸⁹·')


def _dim_str(dim):
    if dim in _NAMED:
        return _NAMED[dim]
    num, den = [], []
    for name, p in zip(_DIM_NAMES, dim):
        if p == 0:
            continue
        (num if p > 0 else den).append(name + ('' if abs(p) == 1 else str(abs(p)).translate(_SUP)))
    s = '·'.join(num) or '1'
    if den:
        s += '/' + ('·'.join(den) if len(den) == 1 else '(' + '·'.join(den) + ')')
    return s


class Quantity:
    """A value with a unit, stored in SI. Arithmetic checks units; .to('mm') gives a plain number."""
    __slots__ = ('si', 'dim')
    __array_priority__ = 1000

    def __init__(self, si, dim):
        self.si = si
        self.dim = tuple(dim)

    # -- conversion
    def to(self, unit):
        """The value as a plain number in `unit` (a string like 'kN*m' or a unit from u)."""
        t = u(unit) if isinstance(unit, str) else unit
        tdim = t.dim if isinstance(t, Quantity) else _ZERO
        tsi = t.si if isinstance(t, Quantity) else t
        if tdim != self.dim:
            raise TypeError(f"can't convert {_dim_str(self.dim)} to {unit}")
        return self.si / tsi

    @property
    def unit(self):
        return _dim_str(self.dim)

    def _check(self, other, op):
        if isinstance(other, Quantity):
            if other.dim != self.dim:
                raise TypeError(f"unsupported units for {op}: {_dim_str(self.dim)} and {_dim_str(other.dim)}")
            return other.si
        if _is_zero(other):
            return 0
        raise TypeError(f"unsupported units for {op}: {_dim_str(self.dim)} and a plain number")

    # -- arithmetic
    def __add__(self, o):
        if _is_zero(o):
            return self
        return Quantity(self.si + self._check(o, '+'), self.dim)

    def __radd__(self, o):
        if _is_zero(o):
            return self
        return Quantity(self._check(o, '+') + self.si, self.dim)

    def __sub__(self, o):
        return Quantity(self.si - self._check(o, '-'), self.dim)

    def __rsub__(self, o):
        return Quantity(self._check(o, '-') - self.si, self.dim)

    def __mul__(self, o):
        if isinstance(o, Quantity):
            return _q(self.si * o.si, [a + b for a, b in zip(self.dim, o.dim)])
        return Quantity(self.si * o, self.dim)

    def __rmul__(self, o):
        return Quantity(o * self.si, self.dim)

    def __truediv__(self, o):
        if isinstance(o, Quantity):
            return _q(self.si / o.si, [a - b for a, b in zip(self.dim, o.dim)])
        return Quantity(self.si / o, self.dim)

    def __rtruediv__(self, o):
        return Quantity(o / self.si, [-a for a in self.dim])

    def __pow__(self, p):
        if isinstance(p, Quantity):
            raise TypeError('an exponent must be a plain number')
        return _q(self.si ** p, [a * p for a in self.dim])

    def __neg__(self):
        return Quantity(-self.si, self.dim)

    def __pos__(self):
        return self

    def __abs__(self):
        return Quantity(abs(self.si), self.dim)

    def __float__(self):
        raise TypeError(f"{self!r} has a unit; use .to('{_dim_str(self.dim)}') for a plain number")

    def __bool__(self):
        return bool(self.si != 0)

    # -- comparison
    def __eq__(self, o):
        if isinstance(o, Quantity):
            return self.dim == o.dim and self.si == o.si
        return _is_zero(o) and self.si == 0

    def __lt__(self, o):
        return self.si < self._check(o, '<')

    def __le__(self, o):
        return self.si <= self._check(o, '<=')

    def __gt__(self, o):
        return self.si > self._check(o, '>')

    def __ge__(self, o):
        return self.si >= self._check(o, '>=')

    def __hash__(self):
        return hash((self.si, self.dim))

    def sqrt(self):
        return self ** 0.5

    # -- display
    def __format__(self, spec):
        # f"{M:.1f kN*m}" → "45.0 kN*m"; f"{M:.3g}" → SI
        if ' ' in spec:
            fmt, unit = spec.split(' ', 1)
            return format(self.to(unit.strip()), fmt) + ' ' + unit.strip()
        return format(self.si, spec) + ' ' + _dim_str(self.dim)

    def __repr__(self):
        v = self.si
        s = f'{v:.6g}' if isinstance(v, float) else repr(v)
        return s + ' ' + _dim_str(self.dim)

    __str__ = __repr__


class _Units:
    """Units: u.kN, u.mm**2, u('kN/m'), u['N*m']."""

    def __init__(self, table):
        self.__dict__.update(table)

    def __call__(self, s):
        return _parse_unit(s)

    def __getitem__(self, s):
        return _parse_unit(s)

    def __repr__(self):
        return '<units: ' + ', '.join(sorted(self.__dict__)) + '>'


def _unit_table():
    t = {}

    def d(**k):
        return tuple(k.get(n, 0) for n in _DIM_NAMES)

    L, M, T, F, P, E, W = d(m=1), d(kg=1), d(s=1), d(kg=1, m=1, s=-2), d(kg=1, m=-1, s=-2), d(kg=1, m=2, s=-2), d(kg=1, m=2, s=-3)

    def add(names, si, dim):
        for n in names.split():
            t[n] = _q(si, dim)

    add('m', 1, L); add('mm', 1e-3, L); add('cm', 1e-2, L); add('dm', 0.1, L); add('km', 1e3, L)
    add('um µm', 1e-6, L); add('nm', 1e-9, L); add('inch', 0.0254, L); add('ft', 0.3048, L)
    add('yd', 0.9144, L); add('mi', 1609.344, L)
    add('kg', 1, M); add('g', 1e-3, M); add('mg', 1e-6, M); add('t tonne', 1e3, M); add('lb', 0.45359237, M)
    add('s', 1, T); add('ms', 1e-3, T); add('us µs', 1e-6, T); add('min', 60, T); add('h hr', 3600, T); add('day', 86400, T)
    add('N', 1, F); add('mN', 1e-3, F); add('kN', 1e3, F); add('MN', 1e6, F); add('kgf', 9.80665, F)
    add('lbf', 4.4482216152605, F); add('kip', 4448.2216152605, F)
    add('Pa', 1, P); add('kPa', 1e3, P); add('MPa', 1e6, P); add('GPa', 1e9, P); add('bar', 1e5, P)
    add('mbar', 100, P); add('atm', 101325, P); add('psi', 6894.757293168, P); add('ksi', 6894757.293168, P)
    add('J', 1, E); add('kJ', 1e3, E); add('MJ', 1e6, E); add('Wh', 3600, E); add('kWh', 3.6e6, E)
    add('cal', 4.184, E); add('kcal', 4184, E)
    add('W', 1, W); add('mW', 1e-3, W); add('kW', 1e3, W); add('MW', 1e6, W); add('hp', 745.69987158227, W)
    add('Hz', 1, d(s=-1)); add('kHz', 1e3, d(s=-1)); add('MHz', 1e6, d(s=-1)); add('rpm', 2 * _math.pi / 60, d(s=-1))
    add('rad', 1, _ZERO); add('deg', _math.pi / 180, _ZERO); add('rev', 2 * _math.pi, _ZERO); add('percent', 0.01, _ZERO)
    add('A', 1, d(A=1)); add('mA', 1e-3, d(A=1)); add('kA', 1e3, d(A=1))
    add('V', 1, d(kg=1, m=2, s=-3, A=-1)); add('mV', 1e-3, d(kg=1, m=2, s=-3, A=-1)); add('kV', 1e3, d(kg=1, m=2, s=-3, A=-1))
    add('ohm Ω', 1, d(kg=1, m=2, s=-3, A=-2)); add('kohm kΩ', 1e3, d(kg=1, m=2, s=-3, A=-2))
    add('C', 1, d(s=1, A=1)); add('F', 1, d(kg=-1, m=-2, s=4, A=2)); add('uF µF', 1e-6, d(kg=-1, m=-2, s=4, A=2))
    add('H', 1, d(kg=1, m=2, s=-2, A=-2)); add('T', 1, d(kg=1, s=-2, A=-1)); add('Wb', 1, d(kg=1, m=2, s=-2, A=-1))
    add('K', 1, d(K=1)); add('mol', 1, d(mol=1)); add('cd', 1, d(cd=1))
    add('L l', 1e-3, d(m=3)); add('mL ml', 1e-6, d(m=3))
    add('g0', 9.80665, d(m=1, s=-2))
    return t


_UNITS = _unit_table()
u = units = _Units(_UNITS)
_UNIT_CACHE = {}


def _parse_unit(s):
    if not isinstance(s, str):
        return s
    key = s
    if key in _UNIT_CACHE:
        return _UNIT_CACHE[key]
    src = s.strip()
    if not src:
        return 1
    src = (src.replace('·', '*').replace('⋅', '*').replace('^', '**')
           .replace('²', '**2').replace('³', '**3').replace('⁴', '**4'))
    src = _re.sub(r'(?<=[\w)])\s+(?=[\w(])', '*', src)
    try:
        v = eval(src, {'__builtins__': {}}, _UNITS)
    except Exception:
        raise ValueError(f"unknown unit '{s}'") from None
    _UNIT_CACHE[key] = v
    return v


def Q(value, unit=''):
    """Q(5, 'kN') → 5 kN. Works with lists and numpy arrays too."""
    return value * _parse_unit(unit) if unit else value


# ---------------------------------------------------------------- bridge


class _Obj(_types.SimpleNamespace):
    """Worksheet objects (beam results, CAD parts): b.M_max or b['M_max']."""

    def __getitem__(self, k):
        return getattr(self, k)

    def __contains__(self, k):
        return hasattr(self, k)

    def keys(self):
        return vars(self).keys()


class _JsFunction:
    __slots__ = ('id', 'name', '__weakref__')

    def __init__(self, id, name):
        self.id = id
        self.name = name

    def __call__(self, *args):
        res = _json.loads(_js_call(self.id, _json.dumps([_enc(a) for a in args])))
        if 'error' in res:
            raise RuntimeError(f"{self.name}: {res['error']}")
        return _dec(res['v'])

    def __repr__(self):
        return f'<worksheet function {self.name}>'


class _Skip(Exception):
    pass


_fns = {}
_PRELUDE = None


def _reset():
    _fns.clear()


def _num(f):
    f = float(f)
    if _math.isfinite(f):
        return f
    return {'t': 'f', 'v': 'nan' if f != f else ('inf' if f > 0 else '-inf')}


def _enc(v, depth=0):
    if depth > 40:
        raise _Skip('too deeply nested')
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, int):
        return v if abs(v) < 2 ** 53 else _num(v)
    if isinstance(v, float):
        return _num(v)
    if isinstance(v, complex):
        return {'t': 'c', 're': _num(v.real), 'im': _num(v.imag)}
    if isinstance(v, str):
        return {'t': 's', 'v': v}
    if isinstance(v, Quantity):
        si = v.si
        if hasattr(si, 'tolist'):
            si = si.tolist()
        if isinstance(si, (list, tuple)):
            return {'t': 'a', 'v': [_enc(Quantity(x, v.dim), depth + 1) for x in si]}
        if isinstance(si, complex) or not isinstance(si, (int, float)):
            raise _Skip('quantity with a ' + type(si).__name__ + ' value')
        return {'t': 'q', 'si': _num(si), 'd': list(v.dim)}
    if isinstance(v, (list, tuple)):
        return {'t': 'a', 'v': [_enc(x, depth + 1) for x in v]}
    if isinstance(v, _JsFunction):
        return {'t': 'jf', 'id': v.id}
    if isinstance(v, (dict, _types.SimpleNamespace)):
        items = v.items() if isinstance(v, dict) else vars(v).items()
        out = {}
        for k, x in items:
            try:
                out[str(k)] = _enc(x, depth + 1)
            except _Skip:
                pass
        return {'t': 'o', 'v': out}
    if hasattr(v, 'tolist') and callable(v.tolist) and not isinstance(v, type):
        return _enc(v.tolist(), depth + 1)  # numpy arrays and scalars
    if callable(v) and not isinstance(v, type):
        fid = len(_fns) + 1
        _fns[fid] = v
        try:
            params = list(_inspect.signature(v).parameters)
        except (TypeError, ValueError):
            params = []
        return {'t': 'pf', 'id': fid, 'p': params}
    raise _Skip(type(v).__name__)


def _dec(v):
    if isinstance(v, (int, float)):
        return v
    t = v['t']
    if t == 'f':
        return float(v['v'])
    if t == 'c':
        return complex(_dec(v['re']), _dec(v['im']))
    if t == 'q':
        return _q(_dec(v['si']), v['d'])
    if t == 's':
        return v['v']
    if t == 'a':
        return [_dec(x) for x in v['v']]
    if t == 'o':
        return _Obj(**{k: _dec(x) for k, x in v['v'].items()})
    if t == 'jf':
        return _JsFunction(v['id'], v.get('n', 'f'))
    if t == 'pf':
        return _fns[v['id']]
    raise ValueError('unknown value ' + t)


def _call_py(fid, args_json):
    try:
        f = _fns[fid]
    except KeyError:
        return _json.dumps({'error': 'this Python function is no longer available; recalculate'})
    try:
        res = f(*[_dec(a) for a in _json.loads(args_json)])
        return _json.dumps({'v': _enc(res)})
    except _Skip as e:
        return _json.dumps({'error': f'returned a value the worksheet cannot use ({e})'})
    except Exception as e:
        return _json.dumps({'error': f'{type(e).__name__}: {e}'})


def _line_of(tb):
    line = None
    for fr in _traceback.extract_tb(tb):
        if fr.filename == '<python>':
            line = fr.lineno
    return line


def _assigned(tree):
    """Names the code assigns with = (or defines with def) outside functions and loops: what
    gets exported. Temporaries inside loops, loop counters, imports and with/except names stay
    private; a variable assigned before a loop and updated inside it is exported."""
    names = {}

    def target(t):
        if isinstance(t, _ast.Name):
            names[t.id] = True
        elif isinstance(t, (_ast.Tuple, _ast.List)):
            for e in t.elts:
                target(e)
        elif isinstance(t, _ast.Starred):
            target(t.value)

    def walk(body, loop):
        for st in body:
            if isinstance(st, _ast.Assign):
                if not loop:
                    for t in st.targets:
                        target(t)
            elif isinstance(st, _ast.AugAssign) or (isinstance(st, _ast.AnnAssign) and st.value is not None):
                if not loop:
                    target(st.target)
            elif isinstance(st, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                if not loop:
                    names[st.name] = True
            elif isinstance(st, (_ast.For, _ast.AsyncFor, _ast.While)):
                walk(st.body, True)
                walk(st.orelse, loop)
            elif isinstance(st, _ast.Match):
                for c in st.cases:
                    walk(c.body, loop)
            elif not isinstance(st, _ast.ClassDef):
                for field in ('body', 'orelse', 'finalbody'):
                    sub = getattr(st, field, None)
                    if isinstance(sub, list):
                        walk(sub, loop)
                for h in getattr(st, 'handlers', None) or []:
                    walk(h.body, loop)

    walk(tree.body, False)
    return names


def _run(code, inputs_json):
    inputs = {k: _dec(x) for k, x in _json.loads(inputs_json).items()}
    ns = {'__name__': '__main__', '__builtins__': __builtins__}
    ns.update(_PRELUDE)
    ns.update(inputs)
    out = _io.StringIO()
    err = None
    exported = {}
    try:
        tree = _ast.parse(code, '<python>')
        exported = _assigned(tree)
        with _contextlib.redirect_stdout(out), _contextlib.redirect_stderr(out):
            exec(compile(tree, '<python>', 'exec'), ns)
    except SyntaxError as e:
        err = {'msg': f'{type(e).__name__}: {e.msg}', 'line': e.lineno if e.filename == '<python>' else None}
    except BaseException as e:  # noqa: B036 - SystemExit and friends must not kill the bridge
        msg = f'{type(e).__name__}: {e}' if str(e) else type(e).__name__
        err = {'msg': msg, 'line': _line_of(e.__traceback__)}
    outputs = []
    if err is None:
        for k, v in list(ns.items()):
            if k.startswith('_') or k not in exported:
                continue
            if k in inputs and v is inputs[k]:
                continue
            if k in _PRELUDE and v is _PRELUDE[k]:
                continue
            if isinstance(v, (_types.ModuleType, type)):
                continue
            try:
                outputs.append({'name': k, 'v': _enc(v)})
            except _Skip as e:
                outputs.append({'name': k, 'skip': str(e)})
    text = out.getvalue()
    if len(text) > 20000:
        text = text[:20000] + '\n… (output truncated)'
    return _json.dumps({'stdout': text, 'error': err, 'outputs': outputs})


_PRELUDE = {'u': u, 'units': units, 'Q': Q, 'Quantity': Quantity, 'math': _math}
