import assert from 'node:assert/strict';

// Invert only this batch's two read-only selectors, never a whole component.
export function normalizeCanvasSmoothness(source) {
  const detail = '  const detail = useValue("frameflow semantic node zoom", () => {\n    const zoom = editor.getZoomLevel();\n    return zoom < 0.48 ? "far" : zoom < 0.72 ? "mid" : "near";\n  }, [editor]);';
  const lazy = '  // Closed pickers must not subscribe every H3 node to the entire page\'s shapes.\n  const canvasMedia=useValue("existing canvas reference media",()=>!(framePicker||canvasReferencePicker)?null:editor.getCurrentPageShapes().flatMap<CanvasPickerItem>(node=>{';
  const deps = '  }),[editor,framePicker,canvasReferencePicker])??[];';
  for (const part of [detail, lazy, deps]) assert.equal(source.split(part).length, 2, 'exact approved selector edit must occur once');
  return source.replace(detail, '  const zoom = useValue("frameflow semantic node zoom", () => editor.getZoomLevel(), [editor]);\n  const detail = zoom < 0.48 ? "far" : zoom < 0.72 ? "mid" : "near";')
    .replace(lazy, '  const canvasMedia=useValue("existing canvas reference media",()=>editor.getCurrentPageShapes().flatMap<CanvasPickerItem>(node=>{')
    .replace(deps, '  }),[editor]);');
}
