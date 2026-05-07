import * as OBC from "@thatopen/components";
import * as WEBIFC from "web-ifc";

export async function loadIfcModel(
  components: OBC.Components,
  file: File,
): Promise<{ model: unknown; data: Uint8Array }> {
  const buffer = await file.arrayBuffer();
  const data = new Uint8Array(buffer);

  const fragments = components.get(OBC.FragmentsManager);
  if (!fragments.initialized) {
    fragments.init(await OBC.FragmentsManager.getWorker());
    /**
     * Default maxUpdateRate (100 ms) drops {@link FRAGS.FragmentsModels.update} calls while the
     * camera is idle — Clipper/slider plane edits then never reach the worker (cuts look broken).
     */
    fragments.core.settings.maxUpdateRate = 0;
  }

  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: "https://unpkg.com/web-ifc@0.0.77/",
      absolute: true,
    },
    customLocateFileHandler: (url) => {
      // Force deterministic wasm location; auto discovery can fail in Next dev.
      if (url.endsWith(".wasm")) {
        return `https://unpkg.com/web-ifc@0.0.77/${url.split("/").pop()}`;
      }
      return url;
    },
  });
  const model = await ifcLoader.load(data, true, file.name, {
    instanceCallback: (importer) => {
      // Tekla exports can contain incomplete grid definitions that crash GridReader.
      // Excluding grid entities avoids the parser null-access without affecting steel elements.
      importer.classes.elements.delete(WEBIFC.IFCGRID);
      importer.classes.elements.delete(WEBIFC.IFCGRIDAXIS);
    },
  });

  return { model, data };
}
