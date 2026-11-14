import { UI_STRINGS } from "../../ui/ui-strings.js";

/** Notice icon (static markup, no external input). */
const NOTICE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"/><g fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" d="M12 7v6m0 3.5v.5"/></g></svg>';
const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

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
  /** Folder whose notice the user closed; the notice returns for any other folder. */
  private dismissedRoot: string | null = null;

  constructor(
    doc: Document,
    private readonly host: WorkspaceTrustHost,
  ) {
    this.element = doc.createElement("div");
    this.element.className = "coloride-trust-banner";
    this.element.setAttribute("role", "status");
    this.element.hidden = true;

    const header = doc.createElement("div");
    header.className = "coloride-trust-banner-header";
    const icon = doc.createElement("span");
    icon.className = "coloride-trust-banner-icon";
    icon.innerHTML = NOTICE_ICON;
    const title = doc.createElement("strong");
    title.textContent = UI_STRINGS.trust.restrictedTitle;
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "coloride-trust-banner-close";
    close.setAttribute("aria-label", UI_STRINGS.trust.dismiss);
    close.innerHTML = CLOSE_ICON;
    close.addEventListener("click", () => this.dismiss());
    header.append(icon, title, close);

    const detail = doc.createElement("p");
    detail.textContent = UI_STRINGS.trust.restrictedDetail;

    // What "Learn more" reveals: the capabilities the trust gate withholds (see AGENTS.md rule 6).
    const more = doc.createElement("p");
    more.className = "coloride-trust-banner-more";
    more.hidden = true;
    more.textContent = UI_STRINGS.trust.learnMoreDetail;

    const actions = doc.createElement("div");
    actions.className = "coloride-trust-banner-actions";
    const learn = doc.createElement("button");
    learn.type = "button";
    learn.className = "coloride-trust-banner-learn";
    learn.textContent = UI_STRINGS.trust.learnMore;
    learn.setAttribute("aria-expanded", "false");
    learn.addEventListener("click", () => {
      more.hidden = !more.hidden;
      learn.setAttribute("aria-expanded", String(!more.hidden));
    });
    this.button = doc.createElement("button");
    this.button.type = "button";
    this.button.className = "coloride-trust-banner-action";
    this.button.textContent = UI_STRINGS.trust.trustFolder;
    this.button.addEventListener("click", () => void this.requestTrust());
    actions.append(learn, this.button);
    this.element.append(header, detail, more, actions);
  }

  getReport(): WorkspaceTrustReport {
    return this.report;
  }

  /** Asks the host for the decision about the folder that is open now. */
  refresh(): Promise<void> {
    return this.track(() => this.host.getTrust());
  }

  private dismiss(): void {
    this.dismissedRoot = this.report.workspaceRoot;
    this.element.hidden = true;
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
    this.element.hidden =
      report.workspaceRoot === null ||
      report.state === "Trusted" ||
      report.workspaceRoot === this.dismissedRoot;
    this.element.dataset.trustState = report.state;
  }

  destroy(): void {
    this.destroyed = true;
    this.element.remove();
  }
}
