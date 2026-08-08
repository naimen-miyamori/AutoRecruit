function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function isLiepinPublicZhaopinUrl(url: string | null | undefined): boolean {
  return /^https:\/\/www\.liepin\.com\/zhaopin\/(?:[?#].*)?$/i.test(normalizeText(url));
}

export function isSafeLiepinResumeUrl(url: string | null | undefined): boolean {
  const normalizedUrl = normalizeText(url);
  return /^https:\/\/h\.liepin\.com\/resume\/showresumedetail\//i.test(normalizedUrl)
    || /^https:\/\/www\.liepin\.com\/a\/resume(?:[/?#].*)?$/i.test(normalizedUrl)
    || /^https:\/\/www\.liepin\.com\/resume(?:\/|[-?])/i.test(normalizedUrl)
    || /^https:\/\/www\.liepin\.com\/resume-detail(?:\/|[-?])/i.test(normalizedUrl);
}
