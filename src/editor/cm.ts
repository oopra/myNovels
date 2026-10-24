import { EditorState, StateField, StateEffect, RangeSetBuilder, type Extension } from '@codemirror/state';
import { EditorView, gutter, GutterMarker, Decoration, type DecorationSet, WidgetType, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { splitParagraphs, type Paragraph } from '../../shared/text';

export interface Marker { paragraph: number; label: string; linkId: number; inputId: number }
export interface EditorCallbacks {
  onChange(doc: string): void;
  onBlur(): void;
  onToggleMark(paragraph: number): void;
  onDropInput(inputId: number, paragraph: number): void;
  onMarkerClick(linkId: number): void;
  onSave(): void;
}
export const DRAG_TYPE = 'application/x-nw-input';

export const setMarked = StateEffect.define<number[]>();
export const setMarkers = StateEffect.define<Marker[]>();
export const setAiParas = StateEffect.define<number[]>();
const setDropTarget = StateEffect.define<number | null>();

const markedField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(v, tr) { for (const e of tr.effects) if (e.is(setMarked)) return new Set(e.value); return v; },
});
const markersField = StateField.define<Marker[]>({
  create: () => [],
  update(v, tr) { for (const e of tr.effects) if (e.is(setMarkers)) return e.value; return v; },
});
const aiField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(v, tr) { for (const e of tr.effects) if (e.is(setAiParas)) return new Set(e.value); return v; },
});
const dropField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) { for (const e of tr.effects) if (e.is(setDropTarget)) return e.value; return v; },
});
/** Paragraphs of the current document, recomputed when it changes. */
const paragraphsField = StateField.define<Paragraph[]>({
  create: s => splitParagraphs(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? splitParagraphs(tr.newDoc.toString()) : v),
});

export function paragraphAt(state: EditorState, pos: number): Paragraph | undefined {
  return state.field(paragraphsField).find(p => pos >= p.from && pos <= p.to);
}

class NumMarker extends GutterMarker {
  constructor(private n: number, private marked: boolean) { super(); }
  toDOM() { const el = document.createElement('span'); el.className = `cm-para-num${this.marked ? ' marked' : ''}`; el.textContent = String(this.n); el.title = this.marked ? 'Marked for line pass (click to unmark)' : 'Click to mark for a line pass'; return el; }
}
class InputMarkerWidget extends WidgetType {
  constructor(private m: Marker, private cb: () => EditorCallbacks) { super(); }
  eq(o: InputMarkerWidget) { return o.m.linkId === this.m.linkId && o.m.label === this.m.label; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-input-marker'; el.textContent = `◆ ${this.m.label}`; el.title = 'Placed input. Click to remove the marker (sets the input back to planned).';
    el.onmousedown = e => { e.preventDefault(); e.stopPropagation(); this.cb().onMarkerClick(this.m.linkId); };
    return el;
  }
  ignoreEvent() { return true; }
}

export function workbenchExtensions(cb: () => EditorCallbacks): Extension {
  const paraGutter = gutter({
    class: 'cm-para-gutter',
    lineMarker(view, line) {
      const paras = view.state.field(paragraphsField);
      const p = paras.find(p => p.from >= line.from && p.from <= line.to);
      return p ? new NumMarker(p.index, view.state.field(markedField).has(p.index)) : null;
    },
    lineMarkerChange: u => u.docChanged || u.transactions.some(t => t.effects.some(e => e.is(setMarked))),
    domEventHandlers: {
      mousedown(view, line) {
        const p = view.state.field(paragraphsField).find(p => p.from >= line.from && p.from <= line.to);
        if (p) cb().onToggleMark(p.index);
        return true;
      },
    },
  });
  const decorations = EditorView.decorations.compute([paragraphsField, markedField, markersField, aiField, dropField], state => {
    const paras = state.field(paragraphsField);
    const marked = state.field(markedField);
    const ai = state.field(aiField);
    const drop = state.field(dropField);
    const markers = state.field(markersField);
    const items: { from: number; to: number; deco: Decoration }[] = [];
    for (const p of paras) {
      const classes = [marked.has(p.index) && 'cm-para-marked', ai.has(p.index) && 'cm-ai-para', drop === p.index && 'cm-para-drop'].filter(Boolean) as string[];
      if (classes.length) {
        let pos = p.from;
        while (pos <= p.to) { const line = state.doc.lineAt(pos); items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: classes.join(' ') }) }); if (line.to >= p.to) break; pos = line.to + 1; }
      }
      for (const m of markers) if (m.paragraph === p.index) items.push({ from: p.to, to: p.to, deco: Decoration.widget({ widget: new InputMarkerWidget(m, cb), side: 1 }) });
    }
    items.sort((a, b) => a.from - b.from || (a.deco.spec.widget ? 1 : -1) - (b.deco.spec.widget ? 1 : -1));
    const b = new RangeSetBuilder<Decoration>();
    for (const it of items) b.add(it.from, it.to, it.deco);
    return b.finish() as DecorationSet;
  });
  const dnd = EditorView.domEventHandlers({
    dragover(e, view) {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return false;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const p = pos == null ? undefined : paragraphAt(view.state, pos);
      const cur = view.state.field(dropField);
      if ((p?.index ?? null) !== cur) view.dispatch({ effects: setDropTarget.of(p?.index ?? null) });
      return true;
    },
    dragleave(_e, view) { if (view.state.field(dropField) != null) view.dispatch({ effects: setDropTarget.of(null) }); return false; },
    drop(e, view) {
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return false;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const p = pos == null ? undefined : paragraphAt(view.state, pos);
      view.dispatch({ effects: setDropTarget.of(null) });
      if (p) cb().onDropInput(Number(raw), p.index);
      return true;
    },
    blur() { cb().onBlur(); return false; },
  });
  const listener = EditorView.updateListener.of(u => { if (u.docChanged) cb().onChange(u.state.doc.toString()); });
  return [
    paragraphsField, markedField, markersField, aiField, dropField,
    paraGutter, decorations, dnd, listener,
    history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
    markdown(),
    keymap.of([{ key: 'Mod-s', run: () => { cb().onSave(); return true; } }, ...defaultKeymap, ...historyKeymap]),
  ];
}
