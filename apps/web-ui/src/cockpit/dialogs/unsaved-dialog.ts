import { UI_STRINGS, uiText } from "../../ui-strings.js";

export type UnsavedChoice = "save" | "discard" | "cancel";

export interface UnsavedPromptOptions {
  readonly message: string;
  /** Text of the primary button; null leaves it out (nothing the dialog could save). */
  readonly saveLabel?: string | null;
  readonly discardLabel?: string;
}

/** Asks what to do with a file that has unsaved changes (see `askUnsavedPrompt`). */
export function askUnsavedChoice(host: HTMLElement, fileName: string): Promise<UnsavedChoice> {
  return askUnsavedPrompt(host, { message: uiText.unsavedPrompt(fileName) });
}

/**
 * Small in-app dialog asking what to do with unsaved changes. It covers its host (the Zone 4
 * panel for one file, the whole window when closing) and resolves once the user picks; Escape or
 * a click outside cancels.
 */
export function askUnsavedPrompt(
  host: HTMLElement,
  options: UnsavedPromptOptions,
): Promise<UnsavedChoice> {
  const doc = host.ownerDocument;
  return new Promise((resolve) => {
    const overlay = doc.createElement("div");
    overlay.className = "coloride-unsaved-overlay";
    const dialog = doc.createElement("div");
    dialog.className = "coloride-unsaved-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "coloride-unsaved-title");

    const title = doc.createElement("h3");
    title.id = "coloride-unsaved-title";
    title.textContent = UI_STRINGS.editor.unsavedTitle;
    const message = doc.createElement("p");
    message.textContent = options.message;

    const actions = doc.createElement("div");
    actions.className = "coloride-unsaved-actions";
    const finish = (choice: UnsavedChoice) => {
      overlay.remove();
      resolve(choice);
    };
    const button = (label: string, choice: UnsavedChoice) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.dataset.choice = choice;
      btn.textContent = label;
      btn.addEventListener("click", () => finish(choice));
      return btn;
    };
    const discard = button(options.discardLabel ?? UI_STRINGS.editor.discard, "discard");
    const cancel = button(UI_STRINGS.editor.cancel, "cancel");
    const save =
      options.saveLabel === null
        ? null
        : button(options.saveLabel ?? UI_STRINGS.editor.save, "save");
    save?.classList.add("coloride-unsaved-primary");
    actions.append(...(save ? [discard, cancel, save] : [discard, cancel]));

    dialog.append(title, message, actions);
    overlay.append(dialog);
    overlay.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        finish("cancel");
      }
    });
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish("cancel");
    });
    host.append(overlay);
    (save ?? cancel).focus();
  });
}
