import type { KeymapPresetId } from "@coloride/editor-cm6";
import { UI_STRINGS } from "../ui/ui-strings.js";
import type { NativeMigrationReport, OnboardingState, QuarantinedMcpServerEntry } from "./types.js";

export interface OnboardingModalActions {
  readonly selectKeymapPreset: (preset: KeymapPresetId) => void;
  readonly approveServer: (serverName: string) => void;
  readonly rejectServer: (serverName: string) => void;
  readonly resetToDefaults: () => void;
  /** Present only when the desktop shell can read the user's IDE configs natively. */
  readonly nativeImport: {
    readonly load: () => Promise<NativeMigrationReport>;
    readonly apply: (report: NativeMigrationReport) => void;
  } | null;
}

const KEYMAP_PRESETS: readonly KeymapPresetId[] = ["VsCode", "Vim", "JetBrains"];

function button(doc: Document, className: string, label: string, onClick: () => void) {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function statusLabel(status: QuarantinedMcpServerEntry["status"]): string {
  if (status === "PendingApproval") {
    return UI_STRINGS.onboarding.pendingApproval;
  }
  return status === "ApprovedByUser"
    ? UI_STRINGS.onboarding.approved
    : UI_STRINGS.onboarding.rejected;
}

function renderImportButton(
  doc: Document,
  nativeImport: NonNullable<OnboardingModalActions["nativeImport"]>,
) {
  const importButton = button(
    doc,
    "coloride-onboarding-import-btn",
    UI_STRINGS.onboarding.importDetected,
    () => {
      importButton.disabled = true;
      importButton.textContent = UI_STRINGS.onboarding.importing;
      void nativeImport
        .load()
        .then((report) => nativeImport.apply(report))
        .catch((error: unknown) => {
          importButton.title =
            error instanceof Error ? error.message : UI_STRINGS.onboarding.importFailed;
          importButton.textContent = UI_STRINGS.onboarding.importRetry;
        })
        .finally(() => {
          importButton.disabled = false;
        });
    },
  );
  return importButton;
}

function renderMcpServer(
  doc: Document,
  server: QuarantinedMcpServerEntry,
  actions: OnboardingModalActions,
) {
  const item = doc.createElement("div");
  item.className = "coloride-quarantined-mcp-item";
  item.dataset.serverName = server.serverName;
  item.dataset.status = server.status;
  item.dataset.enabled = String(server.enabled);

  const labelSpan = doc.createElement("span");
  labelSpan.textContent = `${server.serverName}: ${server.command} ${server.args.join(" ")} [${statusLabel(server.status)}]`;
  item.appendChild(labelSpan);

  for (const action of ["approve", "reject"] as const) {
    const btn = button(doc, `coloride-mcp-${action}-btn`, UI_STRINGS.onboarding[action], () =>
      (action === "approve" ? actions.approveServer : actions.rejectServer)(server.serverName),
    );
    btn.dataset.action = action;
    btn.dataset.serverName = server.serverName;
    item.appendChild(btn);
  }
  return item;
}

/** Rebuilds the onboarding dialog content from `state`. The dialog is small and rarely re-rendered. */
export function renderOnboardingModal(
  modalEl: HTMLElement,
  state: OnboardingState,
  actions: OnboardingModalActions,
): void {
  const doc = modalEl.ownerDocument;
  modalEl.innerHTML = "";
  modalEl.dataset.keymapPreset = state.activeKeymapPreset;
  modalEl.dataset.colorTheme = state.colorTheme;
  modalEl.dataset.modalOpen = String(state.modalOpen);
  modalEl.hidden = !state.modalOpen;
  modalEl.style.display = state.modalOpen ? "block" : "none";

  const title = doc.createElement("h2");
  title.textContent = UI_STRINGS.onboarding.title;
  modalEl.appendChild(title);

  const presetBar = doc.createElement("div");
  presetBar.className = "coloride-onboarding-keymap-presets";
  for (const preset of KEYMAP_PRESETS) {
    const btn = button(
      doc,
      "coloride-keymap-preset-btn",
      preset === "VsCode" ? "VS Code" : preset,
      () => actions.selectKeymapPreset(preset),
    );
    btn.dataset.preset = preset;
    btn.setAttribute("aria-pressed", state.activeKeymapPreset === preset ? "true" : "false");
    presetBar.appendChild(btn);
  }
  modalEl.appendChild(presetBar);

  if (actions.nativeImport) {
    modalEl.appendChild(renderImportButton(doc, actions.nativeImport));
  }

  const mcpSection = doc.createElement("section");
  mcpSection.className = "coloride-onboarding-mcp-quarantine";
  mcpSection.setAttribute("aria-label", UI_STRINGS.onboarding.quarantine);
  for (const server of state.quarantinedMcpServers) {
    mcpSection.appendChild(renderMcpServer(doc, server, actions));
  }
  modalEl.appendChild(mcpSection);

  modalEl.appendChild(
    button(
      doc,
      "coloride-reset-defaults-btn",
      UI_STRINGS.onboarding.resetDefaults,
      actions.resetToDefaults,
    ),
  );
}
