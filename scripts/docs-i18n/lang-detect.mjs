// Lightweight, offline Vietnamese-vs-English language detector for markdown docs.
//
// NOTE: This is a heuristic, not a statistical language model. It is tuned for the
// vi/en pair only and is deliberately conservative. Callers should treat a low
// `confidence` as "uncertain" rather than authoritative.

/** Characters that are essentially unique to Vietnamese orthography. */
const VI_CHARS =
  'ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ';
const VI_CHAR_SET = new Set([...VI_CHARS]);

/** Common Vietnamese function words that rarely appear in English prose. */
const VI_STOPWORDS = new Set([
  'và', 'của', 'các', 'được', 'người', 'không', 'là', 'cho', 'với', 'trong',
  'một', 'những', 'này', 'để', 'có', 'khi', 'như', 'theo', 'về', 'hoặc',
  'nếu', 'thì', 'đã', 'sẽ', 'đang', 'bằng', 'tại', 'trên', 'dưới', 'ý',
  'nội', 'dung', 'tài', 'liệu', 'hệ', 'thống', 'dùng', 'mỗi', 'từng',
]);

/**
 * Remove markdown constructs that are language-neutral (code, URLs, html) so the
 * detector only weighs prose.
 */
export function stripNonProse(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '') // YAML front matter
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/\]\([^)]*\)/g, '] ') // link/image targets, keep link text
    .replace(/https?:\/\/\S+/g, ' ') // bare URLs
    .replace(/<[^>]+>/g, ' '); // html tags
}

/**
 * Detect whether a markdown string is primarily Vietnamese or English.
 * @returns {{ lang: 'vi'|'en'|'unknown', confidence: number, viCharRatio: number, viStopwordHits: number, sampled: number }}
 */
export function detectLang(markdown) {
  const prose = stripNonProse(markdown);

  let letters = 0;
  let viChars = 0;
  for (const ch of prose) {
    if (VI_CHAR_SET.has(ch)) {
      viChars += 1;
      letters += 1;
    } else if (/\p{L}/u.test(ch)) {
      letters += 1;
    }
  }

  const words = prose.toLowerCase().match(/[\p{L}]+/gu) || [];
  let viStopwordHits = 0;
  for (const w of words) {
    if (VI_STOPWORDS.has(w)) viStopwordHits += 1;
  }

  const viCharRatio = letters > 0 ? viChars / letters : 0;
  const stopwordRatio = words.length > 0 ? viStopwordHits / words.length : 0;

  // Decision: any of these signals tips a document to Vietnamese.
  //  - diacritic density above 1.5% of letters, or
  //  - several Vietnamese stopwords with non-trivial density.
  const isVi =
    viCharRatio >= 0.015 ||
    (viStopwordHits >= 4 && stopwordRatio >= 0.02);

  let lang = 'en';
  let confidence;
  if (letters === 0) {
    lang = 'unknown';
    confidence = 0;
  } else if (isVi) {
    lang = 'vi';
    confidence = Math.min(1, viCharRatio * 20 + stopwordRatio * 3 + 0.3);
  } else {
    lang = 'en';
    // High confidence English only when there is meaningful prose and no vi signal.
    confidence = Math.min(1, 0.5 + Math.min(words.length, 200) / 400);
  }

  return {
    lang,
    confidence: Number(confidence.toFixed(3)),
    viCharRatio: Number(viCharRatio.toFixed(4)),
    viStopwordHits,
    sampled: words.length,
  };
}
