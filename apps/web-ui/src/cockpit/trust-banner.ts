import { UI_STRINGS } from "../ui-strings.js";

export type WorkspaceTrustState = "Untrusted" | "Trusted";

export interface WorkspaceTrustReport {
  readonly state: WorkspaceTrustState;
  /** The open folder as the host sees it; null when no folder is open. */
  readonly workspaceRoot: string | null;
}

/**
 * How the cockpit learns and changes the trust decision. The decision itself is taken and kept
 * by the host (a native prompt): the UI can only ask for that prompt, never answer it.
 */
export interface WorkspaceTrustHost {
  getTrust(): Promise<WorkspaceTrustReport>;
  /** Shows the host's trust prompt and resolves with the decision once the user has answered. */
  requestTrust(): Promise<WorkspaceTrustReport>;
}

/**
 * Restricted-mode notice, shown while the open folder is not trusted: editing and highlighting
 * work, but nothing from the folder is run. It floats over the shell so it never moves a zone.
 */
export class TrustBanner {
  readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private report: WorkspaceTrustReport = { state: "Untrusted", workspaceRoot: null };
  /** Bumped on every refresh, so a slow answer about a previous folder is dropped. */
  private sequence = 0;
  private destroyed = false;

  constructor(
    doc: Document,
    private readonly host: WorkspaceTrustHost,
  ) {
    this.element = doc.createElement("div");
    this.element.className = "coloride-trust-banner";
    this.element.setAttribute("role", "status");
    this.element.hidden = true;

    const text = doc.createElement("div");
    const title = doc.createElement("strong");
    title.textContent = UI_STRINGS.trust.restrictedTitle;
    const detail = doc.createElement("span");
    detail.textContent = UI_STRINGS.trust.restrictedDetail;
    text.append(title, detail);

    this.button = doc.createElement("button");
    this.button.type = "button";
    this.button.textContent = UI_STRINGS.trust.trustFolder;
    this.button.addEventListener("click", () => void this.requestTrust());
    this.element.append(text, this.button);
  }

  getReport(): WorkspaceTrustReport {
    return this.report;
  }

  /** Asks the host for the decision about the folder that is open now. */
  refresh(): Promise<void> {
    return this.track(() => this.host.getTrust());
  }

  private async requestTrust(): Promise<void> {
    if (this.button.disabled) return;
    this.button.disabled = true;
    try {
      await this.track(() => this.host.requestTrust());
    } finally {
      this.button.disabled = false;
    }
  }

  private async track(query: () => Promise<WorkspaceTrustReport>): Promise<void> {
    const sequence = ++this.sequence;
    let report: WorkspaceTrustReport;
    try {
      report = await query();
    } catch {
      // Unknown is untrusted: keep (or go back to) restricted mode.
      report = { state: "Untrusted", workspaceRoot: this.report.workspaceRoot };
    }
    if (this.destroyed || sequence !== this.sequence) return;
    this.report = report;
    this.element.hidden = report.workspaceRoot === null || report.state === "Trusted";
    this.element.dataset.trustState = report.state;
  }

  destroy(): void {
    this.destroyed = true;
    this.element.remove();
  }
}
