// Palette contents and the built-in function reference shown in the side panel.

export interface PaletteItem {
  label: string;
  /** Text inserted at the caret; "|" marks where the caret goes. */
  insert: string;
  tip: string;
  /** TeX used for the button face (falls back to label). */
  tex?: string;
}

export const OPERATORS: PaletteItem[] = [
  { label: ':=', insert: ' := ', tip: 'Definition (type :)', tex: '\\coloneqq' },
  { label: '≡', insert: ' ≡ ', tip: 'Global definition (type ~)', tex: '\\equiv' },
  { label: '=', insert: ' =', tip: 'Evaluate numerically', tex: '=' },
  { label: '→', insert: ' → ', tip: 'Evaluate symbolically (Ctrl+.)', tex: '\\rightarrow' },
  { label: '..', insert: ' .. ', tip: 'Range a .. b  or  a, step .. b', tex: 'a..b' },
  { label: 'x²', insert: '^2', tip: 'Square', tex: 'x^2' },
  { label: 'xⁿ', insert: '^|', tip: 'Power', tex: 'x^n' },
  { label: '√', insert: 'sqrt(|)', tip: 'Square root', tex: '\\sqrt{x}' },
  { label: 'ⁿ√', insert: 'nthRoot(|, n)', tip: 'n-th root', tex: '\\sqrt[n]{x}' },
  { label: '|x|', insert: 'abs(|)', tip: 'Absolute value', tex: '|x|' },
  { label: '/', insert: '/', tip: 'Division', tex: '\\frac{a}{b}' },
  { label: '·', insert: ' * ', tip: 'Multiplication', tex: 'a\\cdot b' },
  { label: 'n!', insert: '!', tip: 'Factorial', tex: 'n!' },
  { label: 'eˣ', insert: 'exp(|)', tip: 'Exponential', tex: 'e^x' },
  { label: 'ln', insert: 'ln(|)', tip: 'Natural logarithm', tex: '\\ln' },
  { label: 'log', insert: 'log(|)', tip: 'Base-10 logarithm', tex: '\\log' },
  { label: 'i', insert: '1i', tip: 'Imaginary unit (type 1i)', tex: 'i' },
  { label: 'π', insert: 'π', tip: 'Pi', tex: '\\pi' },
  { label: '∞', insert: '∞', tip: 'Infinity', tex: '\\infty' },
  { label: '°', insert: '°', tip: 'Degree', tex: '{}^{\\circ}' },
  { label: '%', insert: '%', tip: 'Percent', tex: '\\%' },
];

export const CALCULUS: PaletteItem[] = [
  { label: '∫', insert: 'integral(|, x, a, b)', tip: 'Definite integral', tex: '\\int_a^b f\\,dx' },
  { label: 'd/dx', insert: 'diff(|, x)', tip: 'Derivative (numeric at x, or symbolic with →)', tex: '\\frac{d}{dx}' },
  { label: 'dⁿ/dxⁿ', insert: 'diff(|, x, n)', tip: 'n-th derivative', tex: '\\frac{d^n}{dx^n}' },
  { label: 'Σ', insert: 'sum(|, k, 1, n)', tip: 'Summation', tex: '\\sum_{k=1}^{n}' },
  { label: 'Π', insert: 'prod(|, k, 1, n)', tip: 'Product', tex: '\\prod_{k=1}^{n}' },
  { label: 'lim', insert: 'limit(|, x, 0) →', tip: 'Limit (symbolic)', tex: '\\lim_{x\\to a}' },
  { label: '∫ dx', insert: 'integrate(|, x) →', tip: 'Indefinite integral (symbolic)', tex: '\\int f\\,dx' },
];

export const MATRIX: PaletteItem[] = [
  { label: '[ ; ]', insert: '[|; ]', tip: 'Column vector  [1; 2; 3]', tex: '\\begin{bmatrix}a\\\\b\\end{bmatrix}' },
  { label: '[ , ]', insert: '[|, ]', tip: 'Row vector  [1, 2, 3]', tex: '\\begin{bmatrix}a&b\\end{bmatrix}' },
  { label: '2×2', insert: '[|, 0; 0, 0]', tip: 'Matrix: commas between columns, ; between rows', tex: '\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}' },
  { label: 'xᵢ', insert: '[|]', tip: 'Index  v[i],  M[i, j]', tex: 'x_i' },
  { label: 'Aᵀ', insert: "'", tip: "Transpose  A'", tex: 'A^{T}' },
  { label: 'A⁻¹', insert: '^-1', tip: 'Inverse', tex: 'A^{-1}' },
  { label: '|A|', insert: 'det(|)', tip: 'Determinant', tex: '|A|' },
  { label: 'a×b', insert: 'cross(|, b)', tip: 'Cross product', tex: 'a\\times b' },
  { label: 'a·b', insert: 'dot(|, b)', tip: 'Dot product', tex: 'a\\cdot b' },
  { label: 'Σv', insert: 'sum(|)', tip: 'Sum of elements', tex: '\\sum v' },
  { label: 'M⟨j⟩', insert: 'col(|, j)', tip: 'Column j', tex: 'M^{\\langle j\\rangle}' },
];

export const PROGRAMMING: PaletteItem[] = [
  { label: '←', insert: ' ← ', tip: 'Local assignment (or <-)', tex: '\\leftarrow' },
  { label: 'if', insert: 'if |\n  ', tip: 'if condition (indent the body)', tex: '\\textbf{if}' },
  { label: 'else if', insert: 'else if |\n  ', tip: 'else if condition', tex: '\\textbf{else if}' },
  { label: 'else', insert: 'else\n  ', tip: 'otherwise', tex: '\\textbf{else}' },
  { label: 'for', insert: 'for k ∈ 0 .. |\n  ', tip: 'for loop over a range or vector', tex: '\\textbf{for}' },
  { label: 'while', insert: 'while |\n  ', tip: 'while loop', tex: '\\textbf{while}' },
  { label: 'break', insert: 'break', tip: 'Leave the loop', tex: '\\textbf{break}' },
  { label: 'continue', insert: 'continue', tip: 'Next iteration', tex: '\\textbf{continue}' },
  { label: 'return', insert: 'return |', tip: 'Return a value', tex: '\\textbf{return}' },
  { label: 'try', insert: 'try\n  |\non error\n  ', tip: 'Catch errors', tex: '\\textbf{try}' },
  { label: 'if()', insert: 'if(|, a, b)', tip: 'Inline condition if(cond, a, b)', tex: '\\mathrm{if}' },
  { label: '≤', insert: ' ≤ ', tip: 'Less or equal', tex: '\\le' },
  { label: '≥', insert: ' ≥ ', tip: 'Greater or equal', tex: '\\ge' },
  { label: '≠', insert: ' ≠ ', tip: 'Not equal', tex: '\\ne' },
  { label: '==', insert: ' == ', tip: 'Equal (comparison)', tex: '\\boldsymbol{=}' },
  { label: '∧', insert: ' ∧ ', tip: 'And', tex: '\\wedge' },
  { label: '∨', insert: ' ∨ ', tip: 'Or', tex: '\\vee' },
  { label: '¬', insert: '¬', tip: 'Not', tex: '\\neg' },
];

export const SYMBOLIC: PaletteItem[] = [
  { label: '→', insert: ' →', tip: 'Symbolic evaluation', tex: '\\rightarrow' },
  { label: 'simplify', insert: ' → simplify', tip: 'Simplify', tex: '\\mathrm{simplify}' },
  { label: 'expand', insert: ' → expand', tip: 'Expand products and powers', tex: '\\mathrm{expand}' },
  { label: 'factor', insert: ' → factor', tip: 'Factor a polynomial', tex: '\\mathrm{factor}' },
  { label: 'solve', insert: ' → solve, x', tip: 'Solve an equation (use = or leave = 0)', tex: '\\mathrm{solve}' },
  { label: 'float', insert: ' → float, 10', tip: 'Numeric value with n digits', tex: '\\mathrm{float}' },
  { label: 'substitute', insert: ' → substitute, x = 2', tip: 'Substitute a value', tex: '\\mathrm{substitute}' },
  { label: 'series', insert: ' → series, x, 6', tip: 'Taylor series (x = a for another point)', tex: '\\mathrm{series}' },
  { label: 'partfrac', insert: ' → partfrac, x', tip: 'Partial fractions', tex: '\\mathrm{parfrac}' },
  { label: 'coeffs', insert: ' → coeffs, x', tip: 'Polynomial coefficients', tex: '\\mathrm{coeffs}' },
  { label: 'laplace', insert: ' → laplace, t, s', tip: 'Laplace transform', tex: '\\mathcal{L}' },
  { label: 'invlaplace', insert: ' → invlaplace, s, t', tip: 'Inverse Laplace transform', tex: '\\mathcal{L}^{-1}' },
];

const g = (pairs: [string, string][]): PaletteItem[] => pairs.map(([ch, name]) => ({ label: ch, insert: ch, tip: name, tex: ch }));

export const GREEK: PaletteItem[] = g([
  ['α', 'alpha'], ['β', 'beta'], ['γ', 'gamma'], ['δ', 'delta'], ['ε', 'epsilon'], ['ζ', 'zeta'], ['η', 'eta'], ['θ', 'theta'],
  ['ι', 'iota'], ['κ', 'kappa'], ['λ', 'lambda'], ['μ', 'mu'], ['ν', 'nu'], ['ξ', 'xi'], ['π', 'pi'], ['ρ', 'rho'],
  ['σ', 'sigma'], ['τ', 'tau'], ['υ', 'upsilon'], ['φ', 'phi'], ['χ', 'chi'], ['ψ', 'psi'], ['ω', 'omega'],
  ['Γ', 'Gamma'], ['Δ', 'Delta'], ['Θ', 'Theta'], ['Λ', 'Lambda'], ['Ξ', 'Xi'], ['Σ', 'Sigma'], ['Φ', 'Phi'], ['Ψ', 'Psi'], ['Ω', 'Omega'],
]);

export const UNIT_GROUPS: { name: string; units: [string, string][] }[] = [
  { name: 'Length', units: [['mm', 'millimetre'], ['cm', 'centimetre'], ['m', 'metre'], ['km', 'kilometre'], ['um', 'micrometre'], ['in', 'inch'], ['ft', 'foot'], ['yd', 'yard'], ['mi', 'mile']] },
  { name: 'Area & volume', units: [['mm^2', 'square millimetre'], ['m^2', 'square metre'], ['ha', 'hectare'], ['L', 'litre'], ['mL', 'millilitre'], ['m^3', 'cubic metre'], ['gal', 'US gallon']] },
  { name: 'Mass', units: [['gm', 'gram (g is gravity)'], ['kg', 'kilogram'], ['tonne', 'metric tonne'], ['lb', 'pound mass'], ['slug', 'slug']] },
  { name: 'Time', units: [['s', 'second'], ['ms', 'millisecond'], ['min', 'minute'], ['hr', 'hour'], ['day', 'day'], ['year', 'year']] },
  { name: 'Force', units: [['N', 'newton'], ['kN', 'kilonewton'], ['MN', 'meganewton'], ['kgf', 'kilogram-force'], ['lbf', 'pound-force'], ['kip', 'kip']] },
  { name: 'Pressure & stress', units: [['Pa', 'pascal'], ['kPa', 'kilopascal'], ['MPa', 'megapascal'], ['GPa', 'gigapascal'], ['bar', 'bar'], ['atm', 'atmosphere'], ['psi', 'psi'], ['ksi', 'ksi'], ['mmHg', 'mm of mercury']] },
  { name: 'Energy & power', units: [['J', 'joule'], ['kJ', 'kilojoule'], ['kWh', 'kilowatt-hour'], ['cal', 'calorie'], ['BTU', 'BTU'], ['W', 'watt'], ['kW', 'kilowatt'], ['MW', 'megawatt'], ['hp', 'horsepower']] },
  { name: 'Velocity & frequency', units: [['m/s', 'metre per second'], ['km/hr', 'kilometre per hour'], ['kph', 'kilometre per hour'], ['mph', 'mile per hour'], ['knot', 'knot'], ['Hz', 'hertz'], ['kHz', 'kilohertz'], ['rpm', 'revolutions per minute']] },
  { name: 'Angle', units: [['rad', 'radian'], ['deg', 'degree'], ['°', 'degree'], ['rev', 'revolution']] },
  { name: 'Temperature', units: [['K', 'kelvin'], ['degC', 'degree Celsius'], ['degF', 'degree Fahrenheit']] },
  { name: 'Electrical', units: [['A', 'ampere'], ['mA', 'milliampere'], ['V', 'volt'], ['kV', 'kilovolt'], ['ohm', 'ohm'], ['F', 'farad'], ['uF', 'microfarad'], ['H', 'henry'], ['C', 'coulomb'], ['T', 'tesla']] },
  { name: 'Other', units: [['mol', 'mole'], ['cd', 'candela'], ['Pa*s', 'pascal second'], ['cP', 'centipoise'], ['cSt', 'centistokes']] },
];

export interface FunctionDoc {
  name: string;
  sig: string;
  desc: string;
  cat: string;
}

const F = (cat: string, list: [string, string, string][]): FunctionDoc[] => list.map(([name, sig, desc]) => ({ name, sig, desc, cat }));

export const FUNCTIONS: FunctionDoc[] = [
  ...F('Elementary', [
    ['sqrt', 'sqrt(x)', 'Square root'], ['cbrt', 'cbrt(x)', 'Cube root'], ['nthRoot', 'nthRoot(x, n)', 'Real n-th root'],
    ['abs', 'abs(x)', 'Absolute value / magnitude'], ['exp', 'exp(x)', 'e to the power x'], ['ln', 'ln(x)', 'Natural logarithm'],
    ['log', 'log(x [, b])', 'Base-10 logarithm, or base b'], ['sin', 'sin(x)', 'Sine (radians; use deg for degrees)'],
    ['cos', 'cos(x)', 'Cosine'], ['tan', 'tan(x)', 'Tangent'], ['asin', 'asin(x)', 'Inverse sine'], ['acos', 'acos(x)', 'Inverse cosine'],
    ['atan', 'atan(x)', 'Inverse tangent'], ['atan2', 'atan2(y, x)', 'Four-quadrant inverse tangent'], ['sinh', 'sinh(x)', 'Hyperbolic sine'],
    ['cosh', 'cosh(x)', 'Hyperbolic cosine'], ['tanh', 'tanh(x)', 'Hyperbolic tangent'], ['sec', 'sec(x)', 'Secant'], ['csc', 'csc(x)', 'Cosecant'],
    ['cot', 'cot(x)', 'Cotangent'], ['hypot', 'hypot(a, b, …)', 'Euclidean norm of the arguments'],
  ]),
  ...F('Rounding & numbers', [
    ['floor', 'floor(x)', 'Round down'], ['ceil', 'ceil(x)', 'Round up'], ['round', 'round(x [, n])', 'Round to n decimals'],
    ['trunc', 'trunc(x)', 'Round toward zero'], ['mod', 'mod(x, y)', 'Remainder'], ['gcd', 'gcd(a, b, …)', 'Greatest common divisor'],
    ['lcm', 'lcm(a, b, …)', 'Least common multiple'], ['sign', 'sign(x)', 'Sign of x'], ['max', 'max(a, b, … | v)', 'Maximum'],
    ['min', 'min(a, b, … | v)', 'Minimum'], ['factorial', 'factorial(n)', 'n!'], ['combin', 'combin(n, k)', 'Binomial coefficient'],
    ['permut', 'permut(n, k)', 'Permutations'], ['isPrime', 'isPrime(n)', 'Prime test'], ['Heaviside', 'Heaviside(x)', 'Unit step Φ(x)'],
    ['δ', 'δ(m, n)', 'Kronecker delta'],
  ]),
  ...F('Complex', [
    ['Re', 'Re(z)', 'Real part'], ['Im', 'Im(z)', 'Imaginary part'], ['arg', 'arg(z)', 'Argument (angle)'], ['conj', 'conj(z)', 'Complex conjugate'],
    ['csgn', 'csgn(z)', 'Complex sign'], ['signum', 'signum(z)', 'z / |z|'],
  ]),
  ...F('Calculus', [
    ['integral', 'integral(f(x), x, a, b)', 'Definite integral (adaptive Gauss–Kronrod, unit aware, ±∞ allowed)'],
    ['diff', 'diff(f(x), x [, n])', 'n-th derivative at the current value of x (symbolic with →)'],
    ['sum', 'sum(f(k), k, a, b) | sum(v)', 'Summation over integers, a range variable, or vector elements'],
    ['prod', 'prod(f(k), k, a, b)', 'Product'],
    ['limit', 'limit(f(x), x, a) →', 'Limit (symbolic only)'], ['integrate', 'integrate(f(x), x) →', 'Antiderivative (symbolic only)'],
  ]),
  ...F('Solving', [
    ['root', 'root(f(x), x [, a, b])', 'Root from the guess value of x, or within [a, b]'],
    ['polyroots', 'polyroots(v)', 'All roots of a polynomial with ascending coefficients v'],
    ['find', 'find(x, y, …)', 'Solve block: values satisfying the constraints'],
    ['minerr', 'minerr(x, y, …)', 'Solve block: closest approximate solution'],
    ['minimize', 'minimize(f, x, …)', 'Minimize f (inside a solve block for constraints)'],
    ['maximize', 'maximize(f, x, …)', 'Maximize f'],
    ['lsolve', 'lsolve(M, v)', 'Solve the linear system M·x = v'],
  ]),
  ...F('Vectors & matrices', [
    ['rows', 'rows(A)', 'Number of rows'], ['cols', 'cols(A)', 'Number of columns'], ['length', 'length(v)', 'Number of elements'],
    ['last', 'last(v)', 'Index of the last element'], ['augment', 'augment(A, B, …)', 'Join side by side'], ['stack', 'stack(A, B, …)', 'Join top to bottom'],
    ['submatrix', 'submatrix(A, ir, jr, ic, jc)', 'Rows ir..jr, columns ic..jc'], ['col', 'col(A, j)', 'Column j'], ['row', 'row(A, i)', 'Row i'],
    ['identity', 'identity(n)', 'Identity matrix'], ['zeros', 'zeros(m, n)', 'Zero matrix'], ['ones', 'ones(m, n)', 'Matrix of ones'],
    ['matrix', 'matrix(m, n, f)', 'Matrix with elements f(i, j)'], ['diag', 'diag(v)', 'Diagonal matrix / diagonal'],
    ['det', 'det(A)', 'Determinant'], ['inv', 'inv(A)', 'Inverse'], ['tr', 'tr(A)', 'Trace'], ['rank', 'rank(A)', 'Rank'],
    ['transpose', 'transpose(A)', "Transpose (or A')"], ['eigenvals', 'eigenvals(A)', 'Eigenvalues'], ['eigenvecs', 'eigenvecs(A)', 'Eigenvectors (columns)'],
    ['eigenvec', 'eigenvec(A, λ)', 'Normalized eigenvector for eigenvalue λ'], ['norm1', 'norm1(A)', 'L1 norm'], ['norm2', 'norm2(A)', 'Spectral norm'],
    ['norme', 'norme(A)', 'Frobenius norm'], ['normi', 'normi(A)', 'Infinity norm'], ['cross', 'cross(a, b)', 'Cross product'], ['dot', 'dot(a, b)', 'Dot product'],
    ['sort', 'sort(v)', 'Sort ascending'], ['reverse', 'reverse(v)', 'Reverse order'], ['csort', 'csort(A, j)', 'Sort rows by column j'],
    ['rsort', 'rsort(A, i)', 'Sort columns by row i'], ['cumsum', 'cumsum(v)', 'Cumulative sum'], ['lup', 'lup(A)', 'LU decomposition'], ['qr', 'qr(A)', 'QR decomposition'],
  ]),
  ...F('Statistics', [
    ['mean', 'mean(v)', 'Mean'], ['median', 'median(v)', 'Median'], ['mode', 'mode(v)', 'Mode'], ['stdev', 'stdev(v)', 'Population standard deviation'],
    ['Stdev', 'Stdev(v)', 'Sample standard deviation'], ['var', 'var(v)', 'Population variance'], ['Var', 'Var(v)', 'Sample variance'],
    ['corr', 'corr(a, b)', 'Correlation coefficient'], ['hist', 'hist(n | edges, data)', 'Histogram counts'],
    ['dnorm', 'dnorm(x, μ, σ)', 'Normal density'], ['pnorm', 'pnorm(x, μ, σ)', 'Normal CDF'], ['qnorm', 'qnorm(p, μ, σ)', 'Normal quantile'],
    ['pt', 'pt(x, d)', 'Student t CDF'], ['qt', 'qt(p, d)', 'Student t quantile'], ['dt', 'dt(x, d)', 'Student t density'],
    ['pchisq', 'pchisq(x, d)', 'χ² CDF'], ['qchisq', 'qchisq(p, d)', 'χ² quantile'], ['pF', 'pF(x, d1, d2)', 'F CDF'], ['qF', 'qF(p, d1, d2)', 'F quantile'],
    ['dbinom', 'dbinom(k, n, p)', 'Binomial probability'], ['pbinom', 'pbinom(k, n, p)', 'Binomial CDF'],
    ['dpois', 'dpois(k, λ)', 'Poisson probability'], ['ppois', 'ppois(k, λ)', 'Poisson CDF'],
    ['dexp', 'dexp(x, r)', 'Exponential density'], ['pexp', 'pexp(x, r)', 'Exponential CDF'],
    ['dunif', 'dunif(x, a, b)', 'Uniform density'], ['punif', 'punif(x, a, b)', 'Uniform CDF'],
    ['rnd', 'rnd(x)', 'Random number in [0, x)'], ['runif', 'runif(m, a, b)', 'm uniform random numbers'], ['rnorm', 'rnorm(m, μ, σ)', 'm normal random numbers'],
  ]),
  ...F('Interpolation & fitting', [
    ['linterp', 'linterp(vx, vy, x)', 'Linear interpolation (unit aware)'], ['cspline', 'cspline(vx, vy)', 'Cubic spline coefficients for interp'],
    ['interp', 'interp(vs, vx, vy, x)', 'Evaluate a spline'], ['slope', 'slope(vx, vy)', 'Least-squares slope'],
    ['intercept', 'intercept(vx, vy)', 'Least-squares intercept'], ['line', 'line(vx, vy)', '[intercept, slope]'],
    ['polyfit', 'polyfit(vx, vy, n)', 'Polynomial coefficients (ascending)'], ['polyval', 'polyval(c, x)', 'Evaluate a polynomial'],
    ['genfit', 'genfit(vx, vy, vg, F)', 'Nonlinear least-squares fit of F(x, u) from guesses vg'],
  ]),
  ...F('Transforms & ODEs', [
    ['fft', 'fft(v)', 'FFT of real data (non-negative frequencies, 1/√n)'], ['ifft', 'ifft(v)', 'Inverse of fft'],
    ['cfft', 'cfft(v)', 'Complex FFT (1/√n)'], ['icfft', 'icfft(v)', 'Inverse complex FFT'],
    ['rkfixed', 'rkfixed(y0, x1, x2, n, D)', 'RK4 ODE solution matrix [x, y…]; D(x, y) is the derivative vector'],
    ['Rkadapt', 'Rkadapt(y0, x1, x2, n, D)', 'Adaptive Dormand–Prince ODE solution'],
  ]),
  ...F('Special functions', [
    ['gamma', 'gamma(x)', 'Gamma function Γ(x)'], ['erf', 'erf(x)', 'Error function'], ['erfc', 'erfc(x)', 'Complementary error function'],
    ['J0', 'J0(x)', 'Bessel J₀'], ['J1', 'J1(x)', 'Bessel J₁'], ['Jn', 'Jn(n, x)', 'Bessel Jₙ'], ['Y0', 'Y0(x)', 'Bessel Y₀'],
    ['Yn', 'Yn(n, x)', 'Bessel Yₙ'], ['I0', 'I0(x)', 'Modified Bessel I₀'], ['In', 'In(n, x)', 'Modified Bessel Iₙ'],
    ['K0', 'K0(x)', 'Modified Bessel K₀'], ['Kn', 'Kn(n, x)', 'Modified Bessel Kₙ'],
  ]),
  ...F('Logic & strings', [
    ['if', 'if(cond, a, b)', 'Conditional value'], ['concat', 'concat(s1, s2, …)', 'Join strings'], ['strlen', 'strlen(s)', 'String length'],
    ['substr', 'substr(s, start, n)', 'Substring'], ['num2str', 'num2str(x)', 'Number to string'], ['str2num', 'str2num(s)', 'String to number'],
    ['search', 'search(s, sub [, start])', 'Position of substring'], ['UnitsOf', 'UnitsOf(x)', 'Units of a quantity'],
  ]),
];

export const CONSTANTS: PaletteItem[] = [
  { label: 'π', insert: 'π', tip: '3.14159…', tex: '\\pi' },
  { label: 'e', insert: 'e', tip: "Euler's number", tex: 'e' },
  { label: 'g', insert: 'g', tip: 'Standard gravity 9.80665 m/s²', tex: 'g' },
  { label: 'c', insert: 'speedOfLight', tip: 'Speed of light', tex: 'c' },
  { label: 'G', insert: 'gravitationConstant', tip: 'Gravitational constant', tex: 'G' },
  { label: 'h', insert: 'planckConstant', tip: 'Planck constant', tex: 'h' },
  { label: 'k_B', insert: 'boltzmann', tip: 'Boltzmann constant', tex: 'k_B' },
  { label: 'N_A', insert: 'avogadro', tip: 'Avogadro constant', tex: 'N_A' },
  { label: 'R', insert: 'gasConstant', tip: 'Molar gas constant', tex: 'R' },
  { label: 'ε₀', insert: 'vacuumPermittivity', tip: 'Vacuum permittivity', tex: '\\varepsilon_0' },
  { label: 'μ₀', insert: 'vacuumPermeability', tip: 'Vacuum permeability', tex: '\\mu_0' },
  { label: 'qₑ', insert: 'elementaryCharge', tip: 'Elementary charge', tex: 'q_e' },
  { label: 'mₑ', insert: 'electronMass', tip: 'Electron mass', tex: 'm_e' },
  { label: 'σ', insert: 'stefanBoltzmann', tip: 'Stefan–Boltzmann constant', tex: '\\sigma' },
];

export const GREEK_KEYS: Record<string, string> = {
  a: 'α', b: 'β', g: 'γ', d: 'δ', e: 'ε', z: 'ζ', h: 'η', q: 'θ', i: 'ι', k: 'κ', l: 'λ', m: 'μ', n: 'ν', x: 'ξ',
  o: 'ο', p: 'π', r: 'ρ', s: 'σ', t: 'τ', u: 'υ', f: 'φ', c: 'χ', y: 'ψ', w: 'ω',
  G: 'Γ', D: 'Δ', Q: 'Θ', L: 'Λ', X: 'Ξ', P: 'Π', S: 'Σ', F: 'Φ', Y: 'Ψ', W: 'Ω',
};
