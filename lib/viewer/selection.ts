import * as OBC from "@thatopen/components";
import type { MaterialDefinition } from "@thatopen/fragments";

import { SELECTION_HIGHLIGHT_COLOR } from "@/lib/viewer/visual-policy";

export async function highlightExpressIds(
  components: OBC.Components,
  modelId: string,
  expressIds: number[],
) {
  const fragments = components.get(OBC.FragmentsManager);
  const selectionMaterial: MaterialDefinition = {
    color: SELECTION_HIGHLIGHT_COLOR.clone(),
    opacity: 1,
    transparent: false,
    renderedFaces: 0,
  };
  await fragments.highlight(
    selectionMaterial,
    { [modelId]: new Set(expressIds) },
  );
}

export async function clearHighlight(components: OBC.Components) {
  const fragments = components.get(OBC.FragmentsManager);
  await fragments.resetHighlight();
}
