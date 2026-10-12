/** Mask an API key for display: keeps only a short prefix/suffix. Never returns the full key. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`;
}

/** Replace every occurrence of known secrets in a string (used before logging errors/URLs). */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  // query-string style keys, e.g. ?key=AIza...
  out = out.replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, '$1***');
  // Authorization / x-api-key headers if an error dump contains them
  out = out.replace(/((?:authorization|x-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',}]+/gi, '$1***');
  return out;
}
