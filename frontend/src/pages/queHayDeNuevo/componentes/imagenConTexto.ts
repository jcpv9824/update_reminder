import { Node, type Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

/** This action never lifts images out of an existing list or quote. */
function imagenPrincipal(editor: Editor, pos: number | undefined) {
  if (typeof pos !== "number" || pos < 0 || pos >= editor.state.doc.content.size) return null;
  const $pos = editor.state.doc.resolve(pos);
  return $pos.depth === 0 && $pos.nodeAfter?.type.name === "image" ? $pos.nodeAfter : null;
}

export function permiteTextoLateral(editor: Editor, pos: number | undefined) {
  return editor.isEditable && !!imagenPrincipal(editor, pos);
}

export function escribirAlLado(editor: Editor, pos: number | undefined) {
  if (!editor.isEditable || typeof pos !== "number") return;
  const image = imagenPrincipal(editor, pos);
  if (!image) return;
  const { state, view } = editor;
  const pair = state.schema.nodes.imageWithText.createChecked(null, [image, state.schema.nodes.paragraph.create()]);
  const tr = state.tr.replaceWith(pos, pos + image.nodeSize, pair);
  // Opening the pair + image atom + opening the side paragraph.
  tr.setSelection(TextSelection.create(tr.doc, pos + image.nodeSize + 2));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function salirDebajo(editor: Editor) {
  const { state, view } = editor;
  const { $from, $to } = state.selection;
  if ($from.depth !== 2 || $from.node(1).type.name !== "imageWithText" || !$from.sameParent($to)) return false;
  const siguiente = $from.after(1);
  const paragraph = state.schema.nodes.paragraph;
  const vecino = state.doc.nodeAt(siguiente);
  const tr = state.tr;
  if (vecino?.type !== paragraph || vecino.content.size !== 0) {
    tr.insert(siguiente, paragraph.create());
  }
  tr.setSelection(TextSelection.create(tr.doc, siguiente + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function quitarImagenConservandoTexto(editor: Editor) {
  const { state, view } = editor;
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image" ||
      selection.$from.parent.type.name !== "imageWithText") return false;
  const $from = selection.$from;
  const pair = $from.parent;
  const pos = $from.before();
  const tr = state.tr.replaceWith(pos, pos + pair.nodeSize, pair.lastChild!);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** A private image and one formatted paragraph. No HTML import for private media. */
export const ImagenConTexto = Node.create({
  name: "imageWithText",
  content: "image paragraph",
  isolating: true,
  defining: true,
  selectable: false,
  priority: 110,
  renderHTML: () => ["div", { class: "qhdn-imagen-con-texto" }, ["div", { class: "qhdn-imagen-con-texto-fila" }, 0]],
  addKeyboardShortcuts() {
    return {
      Enter: () => salirDebajo(this.editor),
      Backspace: () => quitarImagenConservandoTexto(this.editor),
      Delete: () => quitarImagenConservandoTexto(this.editor),
    };
  },
});

// Do not put this layout in the generic block group: list/quote commands
// would otherwise nest it, but it is a document-level row by contract.
export const DocumentoConImagenLateral = Node.create({
  name: "doc",
  topNode: true,
  content: "(block | imageWithText)+",
});
