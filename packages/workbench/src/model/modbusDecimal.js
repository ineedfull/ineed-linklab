const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu;
const MAX_DECIMAL_DIGITS = 1024;
const MAX_DECIMAL_EXPONENT = 1024;
const MAX_DECIMAL_PLACES = 1024;

export function parseDecimalFraction(value) {
  if (value === null || value === undefined) return null;
  const match = DECIMAL_PATTERN.exec(String(value).trim());
  if (!match) return null;
  const [, sign, whole, fraction = '', exponentSource = '0'] = match;
  if (whole.length + fraction.length > MAX_DECIMAL_DIGITS) return null;
  const exponent = Number(exponentSource);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) return null;
  const decimalPlaces = fraction.length - exponent;
  if (Math.abs(decimalPlaces) > MAX_DECIMAL_PLACES) return null;

  let numerator = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n);
  let denominator = 1n;
  if (decimalPlaces > 0) denominator = 10n ** BigInt(decimalPlaces);
  else if (decimalPlaces < 0) numerator *= 10n ** BigInt(-decimalPlaces);
  return { numerator, denominator };
}

export function compareDecimalFractions(left, right) {
  const leftProduct = left.numerator * right.denominator;
  const rightProduct = right.numerator * left.denominator;
  return leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0;
}
