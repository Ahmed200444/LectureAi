const STOP_WORDS = new Set([
  'about','after','again','also','because','before','being','could','every','first','from','going','have','into','just','more','most','that','their','there','these','they','this','through','using','very','what','when','where','which','with','would','your','then','than','will','were','been','does','did','can','are','the','and','for','but','not','you','our','out','how','why',
  'احنا','إحنا','اللي','يعني','عشان','كده','ده','دي','طيب','تمام','مثلا','مثلاً','هنا','على','إلى','في','من','هو','هي','هذا','هذه','ذلك','تلك','كان','كانت','يكون','تكون','عند','عندي','عندنا','بس','مش','لو','كل','مع','عن','ايه','إيه'
]);

function textOf(segment) {
  return String(segment?.editedText || segment?.originalText || segment?.text || '').trim();
}

function trustworthy(segment) {
  const text = textOf(segment);
  if (!text || segment?.uncertain === true) return false;
  return !/^\s*\[(?:inaudible|uncertain)\]/i.test(text) && !/\[(?:inaudible|uncertain)\]/i.test(text);
}

function source(segment) {
  return {
    startTime: Number(segment.startTime ?? segment.start ?? 0),
    endTime: Number(segment.endTime ?? segment.end ?? segment.startTime ?? 0),
  };
}

function importanceScore(text) {
  let score = Math.min(4, text.length / 120);
  if (/important|remember|key point|exam|definition|defined as|means|therefore|because|conclusion|مهم|خدوا بالكم|امتحان|تعريف|يعني|بالتالي|لأن/i.test(text)) score += 5;
  if (/example|for example|for instance|مثال|مثلاً/i.test(text)) score += 2;
  if (/[=+−*/^]|equation|formula|algorithm|function|derivative|integral|complexity|runtime|pointer|memory|network|model|معادلة|خوارزمية|دالة/i.test(text)) score += 2;
  if (/^(so|therefore|in summary|the main|بالتالي|الخلاصة)/i.test(text)) score += 1.5;
  return score;
}

function representativeSegments(segments, sectionCount = 6, perSection = 2) {
  if (!segments.length) return [];
  const count = Math.min(sectionCount, Math.max(1, Math.ceil(segments.length / 8)));
  const bucketSize = Math.ceil(segments.length / count);
  const picked = [];
  for (let start = 0; start < segments.length; start += bucketSize) {
    const bucket = segments.slice(start, start + bucketSize);
    const ranked = bucket
      .map((segment, index) => ({ segment, index, score: importanceScore(textOf(segment)) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, perSection)
      .sort((a, b) => a.index - b.index);
    picked.push(...ranked.map((item) => item.segment));
  }
  return picked;
}

function extractConcepts(segments, limit = 10) {
  const counts = new Map();
  for (const segment of segments) {
    const text = textOf(segment);
    const tokens = text.match(/[A-Za-z][A-Za-z0-9+.#_-]{1,}|[\u0600-\u06FF]{3,}/g) || [];
    for (const raw of tokens) {
      const key = raw.toLocaleLowerCase();
      if (STOP_WORDS.has(key) || /^\d+$/.test(key)) continue;
      const current = counts.get(key) || { label: raw, count: 0 };
      current.count += 1;
      if (raw.length > current.label.length) current.label = raw;
      counts.set(key, current);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || b.label.length - a.label.length)
    .slice(0, limit)
    .map((item) => item.label);
}

function sourced(segment) {
  return { text: textOf(segment), source: source(segment) };
}

function uniqueByText(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function generateStudyPack(lecture) {
  const sourceVersion = Number(lecture.transcriptVersion || 0);
  const all = (lecture.transcript || []).filter(trustworthy);
  if (!all.length) {
    return {
      sourceVersion,
      generatedAt: new Date().toISOString(),
      summary: [], detailedNotes: [], keyConcepts: [], definitions: [], examples: [], technicalInformation: [], professorEmphasis: [], possibleExamTopics: [], studyQuestions: [],
      warning: 'No trustworthy transcript sections are available yet. Verify the audio and transcript before generating study material.',
    };
  }

  const representative = representativeSegments(all, 7, 2);
  const concepts = extractConcepts(all, 12);
  const definitions = all.filter((segment) => /defined as|means|refers to|we call|definition|هو عبارة عن|هي عبارة عن|يعني|تعريف/i.test(textOf(segment))).map(sourced);
  const examples = all.filter((segment) => /example|for instance|suppose|consider|مثال|مثلاً|افترض|خلينا نفترض/i.test(textOf(segment))).map(sourced);
  const technical = all.filter((segment) => /[=+−*/^]|equation|formula|algorithm|function|derivative|integral|complexity|runtime|memory|pointer|class|object|model|loss|gradient|معادلة|خوارزمية|دالة/i.test(textOf(segment))).map(sourced);
  const emphasis = all.filter((segment) => /important|remember|key point|exam|don't forget|must know|مهم|خدوا بالكم|امتحان|ما تنسوش|لازم تعرف/i.test(textOf(segment))).map(sourced);
  const summary = uniqueByText(representative.filter((_, index) => index % 2 === 0).map(sourced), 7);
  const detailedNotes = uniqueByText(representative.map(sourced), 16);

  return {
    sourceVersion,
    generatedAt: new Date().toISOString(),
    summary,
    detailedNotes,
    keyConcepts: concepts,
    definitions: uniqueByText(definitions, 8),
    examples: uniqueByText(examples, 8),
    technicalInformation: uniqueByText(technical, 10),
    professorEmphasis: uniqueByText(emphasis, 10),
    possibleExamTopics: concepts.slice(0, 8).map((concept) => ({ topic: concept, note: `Review ${concept} and explain it using the original lecture audio. This is a study suggestion, not a claim that the professor promised it will be on an exam.` })),
    studyQuestions: concepts.slice(0, 8).map((concept, index) => ({
      type: index % 3 === 0 ? 'explain' : index % 3 === 1 ? 'apply' : 'compare',
      question: index % 3 === 0 ? `How would you explain ${concept} in your own words using the lecture?` : index % 3 === 1 ? `What is one situation where ${concept} would be applied, based on this lecture?` : `What idea in this lecture is most closely related to ${concept}, and how are they different?`,
    })),
    warning: null,
  };
}

export function applyStudyPack(lecture) {
  const studyPack = generateStudyPack(lecture);
  return { ...lecture, studyPack, studyPackSourceVersion: studyPack.sourceVersion, staleDerivedContent: false, updatedAt: new Date().toISOString() };
}

export function derivedContentIsFresh(lecture) {
  return Boolean(lecture.studyPack) && Number(lecture.studyPackSourceVersion) === Number(lecture.transcriptVersion || 0);
}
