// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import {
  CockpitDomController,
  type WorkspaceTrustReport,
  createCockpitStoreBundle,
} from "../index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A host whose decision per folder only changes when its (native) prompt is answered. */
function setup(answer: "trust" | "decline" = "trust") {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const stores = createCockpitStoreBundle();
  const trusted = new Set<string>();
  let openRoot: string | null = null;
  let prompts = 0;
  const report = (): WorkspaceTrustReport => ({
    state: openRoot !== null && trusted.has(openRoot) ? "Trusted" : "Untrusted",
    workspaceRoot: openRoot,
  });
  const editorView = new ColorideEditorView({
    initialDocumentId: "src/main.ts",
    initialContent: "const ready = true;\n",
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  const controller = new CockpitDomController({
    rootContainer: root,
    stores,
    editorView,
    workspaceTrust: {
      getTrust: async () => report(),
      requestTrust: async () => {
        prompts += 1;
        if (answer === "trust" && openRoot !== null) trusted.add(openRoot);
        return report();
      },
    },
  });
  cleanups.push(() => {
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  const openFolder = async (path: string) => {
    openRoot = path;
    stores.setProjectPath(path);
    await settle();
  };
  const banner = () => root.querySelector<HTMLElement>(".coloride-trust-banner");
  const clickTrust = async () => {
    banner()?.querySelector<HTMLButtonElement>(".coloride-trust-banner-action")?.click();
    await settle();
  };
  return { controller, editorView, openFolder, banner, clickTrust, prompts: () => prompts };
}

describe("workspace trust — restricted mode notice", () => {
  it("shows nothing while no folder is open", async () => {
    const { banner, controller } = setup();
    await settle();
    expect(banner()?.hidden).toBe(true);
    expect(controller.getWorkspaceTrust()).toEqual({ state: "Untrusted", workspaceRoot: null });
  });

  it("a newly opened folder is restricted until the user answers the host's prompt", async () => {
    const { banner, controller, openFolder, clickTrust, prompts } = setup();
    await openFolder("/work/unknown-repo");
    expect(banner()?.hidden).toBe(false);
    expect(controller.getWorkspaceTrust()?.state).toBe("Untrusted");
    expect(prompts()).toBe(0);

    await clickTrust();
    expect(prompts()).toBe(1);
    expect(controller.getWorkspaceTrust()?.state).toBe("Trusted");
    expect(banner()?.hidden).toBe(true);
  });

  it("declining the prompt keeps restricted mode", async () => {
    const { banner, controller, openFolder, clickTrust } = setup("decline");
    await openFolder("/work/unknown-repo");
    await clickTrust();
    expect(controller.getWorkspaceTrust()?.state).toBe("Untrusted");
    expect(banner()?.hidden).toBe(false);
  });

  it("trust does not carry over to another folder", async () => {
    const { banner, openFolder, clickTrust } = setup();
    await openFolder("/work/mine");
    await clickTrust();
    expect(banner()?.hidden).toBe(true);
    await openFolder("/work/downloaded");
    expect(banner()?.hidden).toBe(false);
    await openFolder("/work/mine");
    expect(banner()?.hidden).toBe(true);
  });

  it("editing and Lezer highlighting work normally in an untrusted folder", async () => {
    const { controller, editorView, openFolder } = setup("decline");
    await openFolder("/work/unknown-repo");
    expect(controller.getWorkspaceTrust()?.state).toBe("Untrusted");

    editorView.dispatchUserEdit(0, 0, "export ");
    expect(editorView.getDocumentText()).toBe("export const ready = true;\n");
    // Lezer runs in the webview, with no process involved: keywords are still tokenized.
    const content = editorView.getEditorView().contentDOM;
    const highlighted = Array.from(content.querySelectorAll("span")).filter(
      (span) => span.className !== "" && /^(export|const|true)$/.test(span.textContent ?? ""),
    );
    expect(highlighted.length).toBeGreaterThan(0);
  });
});
