'use client';

import DOMPurify from 'dompurify';
import { Bold, Highlighter, Italic, List, ListOrdered, Redo2, RotateCcw, Save, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { generateNotesHtml } from '../lib/notes';
import type { Lecture } from '../lib/types';

interface NotesEditorProps {
  lecture: Lecture;
  onSave: (lecture: Lecture) => Promise<void>;
  onSeek: (time: number) => void;
}

type RegenerationChoice = { html: string } | null;

export function NotesEditor({ lecture, onSave, onSeek }: NotesEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');
  const [showOriginal, setShowOriginal] = useState(false);
  const [regenerated, setRegenerated] = useState<RegenerationChoice>(null);
  const transcriptVersion = Number(lecture.transcriptVersion || 0);
  const notesFresh = !lecture.segments.length || Number(lecture.notesSourceVersion || 0) === transcriptVersion;

  useEffect(() => {
    if (!editorRef.current || showOriginal) return;
    const safe = DOMPurify.sanitize(lecture.notesCurrent, { ADD_ATTR: ['data-time', 'contenteditable'] });
    if (editorRef.current.innerHTML !== safe) editorRef.current.innerHTML = safe;
  }, [lecture.id, lecture.notesCurrent, showOriginal]);

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  function command(name: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(name, false, value);
    scheduleSave();
  }

  function scheduleSave() {
    if (!editorRef.current) return;
    setSaveState('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const html = DOMPurify.sanitize(editorRef.current?.innerHTML || '', { ADD_ATTR: ['data-time', 'contenteditable'] });
      // Manual note edits preserve the version they were based on. They must not
      // silently pretend stale source-grounded notes became current after transcript edits.
      await onSave({ ...lecture, notesCurrent: html });
      setSaveState('saved');
    }, 700);
  }

  function onEditorClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-time]');
    if (target?.dataset.time) {
      event.preventDefault();
      onSeek(Number(target.dataset.time));
    }
  }

  function createRegeneration() {
    setRegenerated({ html: generateNotesHtml(lecture) });
  }

  async function applyRegeneration(mode: 'replace' | 'alternative') {
    if (!regenerated) return;
    const version = { id: crypto.randomUUID(), html: regenerated.html, createdAt: new Date().toISOString(), label: mode === 'replace' ? 'Regenerated notes' : 'Alternative generated notes' };
    const currentSnapshot = { id: crypto.randomUUID(), html: lecture.notesCurrent, createdAt: new Date().toISOString(), label: 'Edited notes before regeneration' };
    const updated = mode === 'replace'
      ? {
          ...lecture,
          notesCurrent: regenerated.html,
          notesSourceVersion: transcriptVersion,
          derivedContentStale: lecture.translationSourceVersion !== undefined && Number(lecture.translationSourceVersion) !== transcriptVersion,
          noteVersions: [...lecture.noteVersions, currentSnapshot, version],
          updatedAt: new Date().toISOString(),
        }
      : { ...lecture, noteVersions: [...lecture.noteVersions, version], updatedAt: new Date().toISOString() };
    await onSave(updated);
    setRegenerated(null);
  }

  if (showOriginal) {
    return <section className="notes-document read-only"><div className="notes-view-bar"><div><span className="eyebrow">Protected source</span><strong>Original generated version</strong></div><button className="secondary-button" onClick={() => setShowOriginal(false)}>Back to edited notes</button></div><article className="editor-surface" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(lecture.notesOriginal || '<p>No original generated version is available.</p>', { ADD_ATTR: ['data-time'] }) }} onClick={onEditorClick} /></section>;
  }

  return (
    <section className="notes-document">
      <div className="notes-view-bar">
        <div><span className="eyebrow">Current edited version</span><strong>Lecture notes</strong></div>
        <span className={`save-state ${saveState}`}><Save size={14} /> {saveState === 'saving' ? 'Saving…' : 'Saved locally'}</span>
      </div>
      {!notesFresh && <div className="inline-warning"><RotateCcw size={16} /><span>The transcript changed after these notes were generated. Your existing edits are preserved; regenerate when you want notes grounded in the corrected transcript.</span><button className="text-button" onClick={createRegeneration}>Update notes</button></div>}
      <div className="editor-toolbar" role="toolbar" aria-label="Note formatting">
        <button onClick={() => command('bold')} aria-label="Bold"><Bold size={16} /></button>
        <button onClick={() => command('italic')} aria-label="Italic"><Italic size={16} /></button>
        <button onClick={() => command('hiliteColor', '#fff2a8')} aria-label="Highlight"><Highlighter size={16} /></button>
        <span />
        <button onClick={() => command('formatBlock', 'h2')} aria-label="Heading">H2</button>
        <button onClick={() => command('insertUnorderedList')} aria-label="Bulleted list"><List size={17} /></button>
        <button onClick={() => command('insertOrderedList')} aria-label="Numbered list"><ListOrdered size={17} /></button>
        <span />
        <button onClick={() => command('undo')} aria-label="Undo"><Undo2 size={17} /></button>
        <button onClick={() => command('redo')} aria-label="Redo"><Redo2 size={17} /></button>
        <div className="toolbar-spacer" />
        <button className="labeled-tool" onClick={() => setShowOriginal(true)}><RotateCcw size={15} /> Original</button>
        <button className="labeled-tool accent" onClick={createRegeneration}><Sparkles size={15} /> Regenerate</button>
      </div>
      <div ref={editorRef} className="editor-surface" contentEditable suppressContentEditableWarning onInput={scheduleSave} onBlur={scheduleSave} onClick={onEditorClick} aria-label="Editable lecture notes" />
      {regenerated && <div className="modal-backdrop nested"><section className="modal-card regenerate-dialog" role="dialog" aria-modal="true" aria-labelledby="regenerate-title"><p className="eyebrow">Source-grounded draft</p><h2 id="regenerate-title">Regenerated notes are ready</h2><p>Your edited notes have not been changed. Choose how to keep the new version.</p><div className="regenerate-preview" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(regenerated.html, { ADD_ATTR: ['data-time'] }) }} /><div className="button-row wrap"><button className="primary-button" onClick={() => applyRegeneration('replace')}>Replace current notes</button><button className="secondary-button" onClick={() => applyRegeneration('alternative')}>Save as alternative</button><button className="secondary-button" onClick={() => setRegenerated(null)}>Keep existing</button><button className="text-button" onClick={() => setRegenerated(null)}>Cancel</button></div></section></div>}
    </section>
  );
}
