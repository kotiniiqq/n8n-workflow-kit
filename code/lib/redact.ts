/** Mask card numbers (Luhn-checked) and e-mails before text is logged or forwarded.
 *  Shared by several Code nodes: the build inlines it into each one. */
const CARD = /(?<!\d)(?:\d[ .\-/_]{0,2}){12,18}\d(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export function luhnOk(digits: string): boolean {
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[i]);
    if (i % 2 === parity) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    total += d;
  }
  return total % 10 === 0;
}

export function redact(text: string): string {
  return text
    .replace(CARD, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && luhnOk(digits) ? `[card ****${digits.slice(-4)}]` : m;
    })
    .replace(EMAIL, '[email]');
}
