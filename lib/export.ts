import type { Course, Lecture } from './types';
import { formatDuration, formatTime, friendlyDate, safeFilename } from './format';

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function htmlToText(html: string) {
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  return documentFragment.body.innerText.trim();
}

function transcriptMarkdown(lecture: Lecture) {
  return lecture.segments.map((segment) => `**${formatTime(segment.startTime)} – ${formatTime(segment.endTime)}**\n\n${segment.editedText || segment.originalText}`).join('\n\n');
}

function metadata(course: Course, lecture: Lecture) {
  return `${course.name} (${course.code})\n${lecture.title}\n${friendlyDate(lecture.date)} · ${course.professor} · ${formatDuration(lecture.duration)}`;
}

export function exportMarkdown(course: Course, lecture: Lecture, kind: 'notes' | 'transcript' | 'combined' = 'combined') {
  const notes = htmlToText(lecture.notesCurrent).split('\n').map((line) => line.trim()).filter(Boolean).join('\n\n');
  const transcript = transcriptMarkdown(lecture);
  const body = kind === 'notes' ? notes : kind === 'transcript' ? transcript : `## Edited Lecture Notes\n\n${notes}\n\n---\n\n## Full Transcript\n\n${transcript}`;
  download(new Blob([`# ${course.name}\n\n## ${lecture.title}\n\n${metadata(course, lecture)}\n\n---\n\n${body}\n`], { type: 'text/markdown;charset=utf-8' }), `${safeFilename(lecture.title)}-${kind}.md`);
}

export function exportTranscriptText(course: Course, lecture: Lecture) {
  const transcript = lecture.segments.map((segment) => `[${formatTime(segment.startTime)} - ${formatTime(segment.endTime)}]\n${segment.editedText || segment.originalText}`).join('\n\n');
  download(new Blob([`${metadata(course, lecture)}\n\n${transcript}`], { type: 'text/plain;charset=utf-8' }), `${safeFilename(lecture.title)}-transcript.txt`);
}

export function exportBackupJson(payload: unknown) {
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `LectureAI-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

export async function exportDocx(course: Course, lecture: Lecture) {
  const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx');
  const notesText = htmlToText(lecture.notesCurrent);
  const children = [
    new Paragraph({ text: course.name, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: lecture.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: `${course.code} · ${course.professor}`, bold: true }), new TextRun(`\n${friendlyDate(lecture.date)} · ${formatDuration(lecture.duration)}`)] }),
    new Paragraph({ text: 'Edited Lecture Notes', heading: HeadingLevel.HEADING_1 }),
    ...notesText.split(/\n+/).filter(Boolean).map((line) => new Paragraph({ text: line, spacing: { after: 140 }, bidirectional: /[\u0600-\u06FF]/.test(line) })),
    new Paragraph({ text: 'Full Transcript', heading: HeadingLevel.HEADING_1 }),
    ...lecture.segments.flatMap((segment) => [
      new Paragraph({ children: [new TextRun({ text: `${formatTime(segment.startTime)} – ${formatTime(segment.endTime)}`, bold: true, color: '315F4B' })], spacing: { before: 140 } }),
      new Paragraph({ text: segment.editedText || segment.originalText, bidirectional: /[\u0600-\u06FF]/.test(segment.editedText || segment.originalText), alignment: /[\u0600-\u06FF]/.test(segment.editedText || segment.originalText) ? AlignmentType.RIGHT : AlignmentType.LEFT }),
    ]),
  ];
  const documentFile = new Document({ sections: [{ properties: {}, children }] });
  download(await Packer.toBlob(documentFile), `${safeFilename(lecture.title)}.docx`);
}

export function printPdf(course: Course, lecture: Lecture) {
  const printWindow = window.open('', '_blank', 'noopener,noreferrer');
  if (!printWindow) throw new Error('Allow pop-ups to open the print-to-PDF view.');
  const transcript = lecture.segments.map((segment) => `<section dir="auto"><strong>${formatTime(segment.startTime)} – ${formatTime(segment.endTime)}</strong><p>${escapePrint(segment.editedText || segment.originalText)}</p></section>`).join('');
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapePrint(lecture.title)}</title><style>body{font:12pt/1.55 Arial,sans-serif;color:#17221c;max-width:760px;margin:48px auto;padding:0 24px}h1,h2{font-family:Georgia,serif;color:#214f3d}header{border-bottom:2px solid #214f3d;margin-bottom:28px}.meta{color:#667069}section{break-inside:avoid;margin:16px 0}strong{color:#315f4b}button{display:none}@media print{body{margin:0}}</style></head><body><header><h1>${escapePrint(course.name)}</h1><h2>${escapePrint(lecture.title)}</h2><p class="meta">${escapePrint(metadata(course, lecture))}</p></header><h2>Edited Lecture Notes</h2><article>${lecture.notesCurrent}</article><h2>Full Transcript</h2>${transcript}<script>window.onload=()=>window.print()<\/script></body></html>`);
  printWindow.document.close();
}

function escapePrint(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] || character);
}

export function downloadBlob(blob: Blob, filename: string) {
  download(blob, safeFilename(filename));
}
