import { UI_STRINGS, uiText } from "../ui-strings.js";

export type UnsavedChoice = "save" | "discard" | "cancel";

/**
 * Small in-app dialog asking what to do with a file that has unsaved changes. It covers its host
 * (the Zone 4 panel) and resolves once the user picks; Escape or a click outside cancels.
 */
export function askUnsavedChoice(host: HTMLElement, fileName: string): Promise<UnsavedChoice> {
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
    message.textContent = uiText.unsavedPrompt(fileName);

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
    const save = button(UI_STRINGS.editor.save, "save");
    save.classList.add("coloride-unsaved-primary");
    actions.append(
      button(UI_STRINGS.editor.discard, "discard"),
      button(UI_STRINGS.editor.cancel, "cancel"),
      save,
    );

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
    save.focus();
  });
}
