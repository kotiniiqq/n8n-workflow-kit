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

/** The digit run may swallow what follows the card ("4111…1111-12/25"), so try the longest
 *  Luhn-valid prefix of 13–19 digits and keep the rest of the match as it was. */
function maskCard(match: string): string {
  const digits = match.replace(/\D/g, '');
  for (let len = Math.min(19, digits.length); len >= 13; len--) {
    if (!luhnOk(digits.slice(0, len))) continue;
    let seen = 0;
    let cut = 0;
    while (seen < len) if (/\d/.test(match[cut++])) seen++;
    return `[card ****${digits.slice(len - 4, len)}]${match.slice(cut)}`;
  }
  return match;
}

export function redact(text: string): string {
  return text.replace(CARD, maskCard).replace(EMAIL, '[email]');
}
