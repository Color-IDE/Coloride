import { NewPanelMenu } from "../cockpit/panels/new-panel-menu.js";
import { sessionIcon } from "../cockpit/panels/session-presentation.js";
import { type WorkGroup, listProjects } from "../state/workspace-navigation.js";
import type { CockpitChatTab, CockpitFileTreeNode, CockpitStoreBundle } from "../stores/index.js";
import { attribute, button, reconcile, visibility } from "../ui/dom-utils.js";
import { UI_STRINGS } from "../ui/ui-strings.js";
import { FOLDER_ICON, GROUP_ICON } from "./icons.js";
import {
  MENU_CHEVRONS_DOWN_ICON,
  MENU_CHEVRONS_UP_ICON,
  MENU_CHEVRON_DOWN_ICON,
  MENU_CHEVRON_UP_ICON,
  MENU_CLOSE_ICON,
  MENU_CLOSE_MANY_ICON,
  MENU_COPY_ICON,
  MENU_FOLDER_ICON,
  MENU_FOLDER_MINUS_ICON,
  MENU_MAXIMIZE_ICON,
  MENU_RENAME_ICON,
  MENU_RESTORE_ICON,
  MENU_TRASH_ICON,
} from "./menu-icons.js";
import { SidebarMenu } from "./sidebar-menu.js";
import { SidebarRow } from "./sidebar-row.js";

interface GroupNodes {
  readonly el: HTMLElement;
  readonly row: SidebarRow;
  readonly sessions: HTMLElement;
  readonly chats: Map<string, SidebarRow>;
}

interface ProjectNodes {
  readonly el: HTMLElement;
  readonly folder: SidebarRow;
  readonly tree: HTMLElement;
  readonly groups: Map<string, GroupNodes>;
}

export interface WorkspaceSidebarOptions {
  readonly controlsHost: HTMLElement;
  readonly treeHost: HTMLElement;
  readonly stores: CockpitStoreBundle;
  readonly openWorkspace?: () => Promise<readonly CockpitFileTreeNode[] | null>;
  /**
   * Makes another already-listed project the active one (host root, file tree).
   * Without it the sidebar only switches the navigation state.
   */
  readonly switchWorkspace?: (path: string) => Promise<readonly CockpitFileTreeNode[] | null>;
  /** What the "+" of a group opens: a terminal panel, or an agent session (the default). */
  readonly newSessionKind?: "terminal" | "agent";
}

/** Owns sidebar navigation DOM and subscriptions, independent of the editor and streaming. */
export class WorkspaceSidebar {
  private readonly projects = new Map<string, ProjectNodes>();
  private readonly projectsEl: HTMLElement;
  private readonly openProjectButton: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly menu: SidebarMenu;
  private readonly newPanelMenu: NewPanelMenu;
  private readonly unsubscribers: Array<() => void> = [];
  private opening = false;
  private switching = false;
  private destroyed = false;

  constructor(private readonly options: WorkspaceSidebarOptions) {
    const { controlsHost, treeHost, stores } = options;
    const doc = treeHost.ownerDocument;
    controlsHost.className = "sidebar-project-controls";
    treeHost.className = "sidebar-navigation";
    treeHost.setAttribute("aria-label", UI_STRINGS.sidebar.navigation);
    this.menu = new SidebarMenu(treeHost);
    this.newPanelMenu = new NewPanelMenu(treeHost.ownerDocument);
    this.openProjectButton = button(
      doc,
      "sidebar-row sidebar-open-project sidebar-open-project-label",
      UI_STRINGS.sidebar.openProject,
    );
    this.openProjectButton.innerHTML = `<span class="sidebar-open-project-icon" aria-hidden="true">${FOLDER_ICON}</span><span>${UI_STRINGS.sidebar.openProject}</span>`;
    this.openProjectButton.disabled = !options.openWorkspace;
    this.openProjectButton.title = UI_STRINGS.sidebar.openProjectHint;
    this.openProjectButton.addEventListener("click", () => {
      void this.openProject();
    });
    this.error = doc.createElement("p");
    this.error.className = "sidebar-error";
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    controlsHost.append(this.openProjectButton, this.error);

    this.projectsEl = doc.createElement("div");
    this.projectsEl.className = "sidebar-projects";
    treeHost.append(this.projectsEl);
    this.update();
    this.unsubscribers.push(
      stores.navigation.subscribe(() => this.update()),
      stores.zone3.subscribe((next, prev) => {
        if (next.activeChatId !== prev.activeChatId || next.chats !== prev.chats) this.update();
      }),
    );
  }

  /** A session can be closed unless an agent is running in it or waiting its turn. */
  private canClose(chatId: string): boolean {
    const state = this.options.stores.zone3.getState();
    return (
      state.chats.length > 1 &&
      state.activeRunningAgentChatId !== chatId &&
      !state.sequentialAgentQueue.includes(chatId)
    );
  }

  /** Closes sessions one by one; the store keeps the last session of the app open. */
  private closeSessions(chatIds: readonly string[]): void {
    for (const id of chatIds) this.options.stores.closeChat(id);
  }

  /** A new session (or terminal) in a group, next to `from` when given. */
  private addSession(projectPath: string, groupId: string, kind?: "terminal", from?: string): void {
    const { stores } = this.options;
    this.withProject(projectPath, () => {
      const created = stores.createChat({
        groupId,
        ...(kind ? { kind } : {}),
        ...(from ? { from } : {}),
      });
      if (created === null) {
        this.showError(null, UI_STRINGS.sidebar.noRoom);
        return;
      }
      this.error.hidden = true;
      stores.setWorkGroupExpanded(groupId, true);
    });
  }

  private copyPath(path: string): void {
    const doc = this.options.treeHost.ownerDocument;
    void doc.defaultView?.navigator.clipboard?.writeText(path).catch(() => {
      // The clipboard can be refused (no permission or focus): there is nothing to recover.
    });
  }

  private expandAll(expanded: boolean): void {
    this.options.stores.setAllWorkGroupsExpanded(expanded);
  }

  private showError(error: unknown, fallback: string): void {
    if (this.destroyed) return;
    this.error.textContent = error instanceof Error ? error.message : fallback;
    this.error.hidden = false;
  }

  /** Switches the active project, then runs `run` against it. Runs synchronously when already active. */
  private withProject(path: string, run: () => void): void {
    const { stores } = this.options;
    if (stores.navigation.getState().projectPath === path) {
      run();
      return;
    }
    void this.switchTo(path).then((switched) => {
      if (switched && !this.destroyed) run();
    });
  }

  private async switchTo(path: string): Promise<boolean> {
    const { stores, switchWorkspace } = this.options;
    if (this.switching || this.destroyed) return false;
    this.switching = true;
    this.error.hidden = true;
    try {
      if (switchWorkspace) {
        const nodes = await switchWorkspace(path);
        if (!nodes) return false;
        if (!this.destroyed) stores.setFileTree(nodes);
        // The host callback normally activates the project; make sure navigation agrees.
        stores.setProjectPath(path);
      } else {
        stores.setProjectPath(path);
      }
      return true;
    } catch (error: unknown) {
      this.showError(error, UI_STRINGS.sidebar.switchFailed);
      return false;
    } finally {
      this.switching = false;
    }
  }

  private async removeProject(path: string): Promise<void> {
    const { stores } = this.options;
    const navigation = stores.navigation.getState();
    if (navigation.projectPath === path) {
      const next = listProjects(navigation).find((entry) => entry.path !== path);
      if (next && !(await this.switchTo(next.path))) return;
    }
    if (!this.destroyed) stores.removeProject(path);
  }

  private async openProject(): Promise<void> {
    if (!this.options.openWorkspace || this.opening || this.destroyed) return;
    this.opening = true;
    this.openProjectButton.disabled = true;
    this.openProjectButton.setAttribute("aria-busy", "true");
    this.openProjectButton.title = UI_STRINGS.sidebar.opening;
    this.error.hidden = true;
    try {
      const nodes = await this.options.openWorkspace();
      if (!this.destroyed && nodes) this.options.stores.setFileTree(nodes);
    } catch (error: unknown) {
      if (!this.destroyed) {
        this.error.textContent =
          error instanceof Error ? error.message : UI_STRINGS.sidebar.openFailed;
        this.error.hidden = false;
      }
    } finally {
      this.opening = false;
      if (!this.destroyed) {
        this.openProjectButton.disabled = false;
        this.openProjectButton.setAttribute("aria-busy", "false");
        this.openProjectButton.title = UI_STRINGS.sidebar.openProjectHint;
      }
    }
  }

  private createGroup(projectPath: string, group: WorkGroup): GroupNodes {
    const { treeHost, stores } = this.options;
    const doc = treeHost.ownerDocument;
    const el = doc.createElement("section");
    el.className = "sidebar-group";
    el.dataset.groupId = group.id;
    const sessions = doc.createElement("div");
    sessions.className = "sidebar-sessions";
    const row = new SidebarRow(doc, {
      kind: "group",
      icon: GROUP_ICON,
      onSelect: () => this.withProject(projectPath, () => stores.selectWorkGroup(group.id)),
      onAdd: (anchor) => {
        // With terminals available the "+" offers the same choices as the one of the panels.
        if (this.options.newSessionKind === "terminal") {
          this.newPanelMenu.toggle(anchor, {
            openTerminal: () => this.addSession(projectPath, group.id, "terminal"),
            openAgentInterface: () => this.addSession(projectPath, group.id),
          });
        } else this.addSession(projectPath, group.id);
      },
      onToggle: () =>
        this.withProject(projectPath, () => {
          const latest = stores.navigation.getState().groups.find((item) => item.id === group.id);
          if (latest) stores.setWorkGroupExpanded(group.id, !(latest.expanded ?? true));
        }),
      onMore: (anchor) => {
        const state = stores.navigation.getState();
        const entry = listProjects(state).find((item) => item.path === projectPath);
        const latest = entry?.groups.find((item) => item.id === group.id);
        if (!entry || !latest) return;
        const expanded = latest.expanded !== false;
        const closable = latest.chatIds.filter((id) => this.canClose(id));
        this.menu.open(anchor, [
          {
            label: UI_STRINGS.sidebar.renameGroup,
            icon: MENU_RENAME_ICON,
            run: () =>
              this.withProject(projectPath, () =>
                row.rename(latest.title, (name) => stores.renameWorkGroup(group.id, name)),
              ),
          },
          {
            label: expanded ? UI_STRINGS.sidebar.collapseGroup : UI_STRINGS.sidebar.expandGroup,
            icon: expanded ? MENU_CHEVRON_UP_ICON : MENU_CHEVRON_DOWN_ICON,
            run: () =>
              this.withProject(projectPath, () => stores.setWorkGroupExpanded(group.id, !expanded)),
          },
          {
            label: UI_STRINGS.sidebar.closeAllSessions,
            icon: MENU_CLOSE_MANY_ICON,
            separatorBefore: true,
            danger: true,
            disabled: closable.length === 0,
            ...(closable.length === 0 ? { reason: UI_STRINGS.sidebar.noSessionToClose } : {}),
            run: () => this.closeSessions(closable),
          },
          {
            label: UI_STRINGS.sidebar.deleteGroup,
            icon: MENU_TRASH_ICON,
            danger: true,
            disabled: latest.chatIds.length > 0 || entry.groups.length <= 1,
            reason:
              entry.groups.length <= 1
                ? UI_STRINGS.sidebar.deleteLastGroup
                : UI_STRINGS.sidebar.deleteGroupNeedsEmpty,
            run: () => this.withProject(projectPath, () => stores.removeWorkGroup(group.id)),
          },
        ]);
      },
    });
    row.select.dataset.groupId = group.id;
    row.toggle?.setAttribute("aria-controls", `sidebar-sessions-${group.id}`);
    sessions.id = `sidebar-sessions-${group.id}`;
    el.append(row.el, sessions);
    return { el, row, sessions, chats: new Map() };
  }

  /**
   * Adds a group to a project and leaves its name ready to type: the group is created with a
   * default name, selected, and its row goes straight into rename (Escape keeps the default).
   */
  private addGroup(projectPath: string): void {
    const { stores } = this.options;
    this.withProject(projectPath, () => {
      this.error.hidden = true;
      stores.setProjectExpanded(true, projectPath);
      const taken = new Set(stores.navigation.getState().groups.map((group) => group.title));
      const base = UI_STRINGS.sidebar.newGroup;
      let title: string = base;
      for (let n = 2; taken.has(title); n += 1) title = `${base} ${n}`;
      stores.createWorkGroup(title);
      // The navigation subscription has already rendered the new row.
      const id = stores.navigation.getState().activeGroupId;
      this.projects
        .get(projectPath)
        ?.groups.get(id)
        ?.row.rename(title, (name) => stores.renameWorkGroup(id, name));
    });
  }

  private createSession(projectPath: string, groupId: string, chat: CockpitChatTab): SidebarRow {
    const { stores, treeHost } = this.options;
    const row = new SidebarRow(treeHost.ownerDocument, {
      kind: "session",
      onSelect: () => {
        // selectChat records the owning group and the selected session in one step.
        this.withProject(projectPath, () => stores.selectChat(chat.chatId));
      },
      onMore: (anchor) => {
        const state = stores.zone3.getState();
        const latest = state.chats.find((item) => item.chatId === chat.chatId);
        if (!latest) return;
        const group = stores.navigation.getState().groups.find((item) => item.id === groupId);
        const alone = group?.maximizedChatId === chat.chatId;
        const others = (group?.chatIds ?? []).filter(
          (id) => id !== chat.chatId && this.canClose(id),
        );
        this.menu.open(anchor, [
          {
            label: UI_STRINGS.sidebar.renameSession,
            icon: MENU_RENAME_ICON,
            run: () => row.rename(latest.title, (name) => stores.renameChat(chat.chatId, name)),
          },
          {
            label: UI_STRINGS.sidebar.duplicateSession,
            icon: MENU_COPY_ICON,
            run: () =>
              this.addSession(
                projectPath,
                groupId,
                latest.kind === "terminal" ? "terminal" : undefined,
                chat.chatId,
              ),
          },
          {
            label: alone ? UI_STRINGS.sidebar.restoreSession : UI_STRINGS.sidebar.maximizeSession,
            icon: alone ? MENU_RESTORE_ICON : MENU_MAXIMIZE_ICON,
            run: () => this.withProject(projectPath, () => stores.toggleMaximizeChat(chat.chatId)),
          },
          {
            label: UI_STRINGS.sidebar.closeSession,
            icon: MENU_CLOSE_ICON,
            separatorBefore: true,
            danger: true,
            disabled: !this.canClose(chat.chatId),
            ...(this.canClose(chat.chatId) ? {} : { reason: UI_STRINGS.sidebar.noSessionToClose }),
            run: () => stores.closeChat(chat.chatId),
          },
          {
            label: UI_STRINGS.sidebar.closeOtherSessions,
            icon: MENU_CLOSE_MANY_ICON,
            danger: true,
            disabled: others.length === 0,
            ...(others.length === 0 ? { reason: UI_STRINGS.sidebar.noSessionToClose } : {}),
            run: () => this.closeSessions(others),
          },
        ]);
      },
    });
    row.el.dataset.chatId = chat.chatId;
    row.el.dataset.groupId = groupId;
    row.select.dataset.chatId = chat.chatId;
    return row;
  }

  private createProject(path: string): ProjectNodes {
    const { treeHost, stores, openWorkspace } = this.options;
    const doc = treeHost.ownerDocument;
    const el = doc.createElement("section");
    el.className = "sidebar-project";
    el.dataset.projectPath = path;
    const tree = doc.createElement("div");
    tree.className = "sidebar-group-tree";
    const folder = new SidebarRow(doc, {
      kind: "folder",
      onAdd: () => this.addGroup(path),
      addLabel: { aria: UI_STRINGS.sidebar.newGroupIn, title: UI_STRINGS.sidebar.newGroup },
      onSelect: () => {
        const entry = listProjects(stores.navigation.getState()).find((item) => item.path === path);
        stores.setProjectExpanded(!(entry?.expanded ?? true), path);
      },
      onMore: (anchor) => {
        const entry = listProjects(stores.navigation.getState()).find((item) => item.path === path);
        const expanded = entry?.expanded ?? true;
        this.menu.open(anchor, [
          {
            label: expanded ? UI_STRINGS.sidebar.collapseProject : UI_STRINGS.sidebar.expandProject,
            icon: expanded ? MENU_CHEVRON_UP_ICON : MENU_CHEVRON_DOWN_ICON,
            run: () => stores.setProjectExpanded(!expanded, path),
          },
          {
            label: UI_STRINGS.sidebar.expandAll,
            icon: MENU_CHEVRONS_DOWN_ICON,
            run: () => this.withProject(path, () => this.expandAll(true)),
          },
          {
            label: UI_STRINGS.sidebar.collapseAll,
            icon: MENU_CHEVRONS_UP_ICON,
            run: () => this.withProject(path, () => this.expandAll(false)),
          },
          {
            label: UI_STRINGS.sidebar.copyPath,
            icon: MENU_COPY_ICON,
            separatorBefore: true,
            disabled: path === "",
            run: () => this.copyPath(path),
          },
          {
            label: UI_STRINGS.sidebar.openProjectMenu,
            icon: MENU_FOLDER_ICON,
            disabled: !openWorkspace || this.opening,
            run: () => {
              void this.openProject();
            },
          },
          {
            label: UI_STRINGS.sidebar.removeProject,
            icon: MENU_FOLDER_MINUS_ICON,
            separatorBefore: true,
            danger: true,
            disabled: path === "",
            run: () => {
              void this.removeProject(path);
            },
          },
        ]);
      },
    });
    el.append(folder.el, tree);
    return { el, folder, tree, groups: new Map() };
  }

  private update(): void {
    const { stores } = this.options;
    const focused = this.options.treeHost.ownerDocument.activeElement as HTMLElement | null;
    const hadFocus = focused !== null && this.options.treeHost.contains(focused);
    const navigation = stores.navigation.getState();
    const chatState = stores.zone3.getState();
    const chats = new Map(chatState.chats.map((chat) => [chat.chatId, chat]));
    const entries = listProjects(navigation);
    const retainedProjects = new Set(entries.map((entry) => entry.path));
    for (const [path] of this.projects) {
      if (!retainedProjects.has(path)) {
        this.menu.close(false);
        this.projects.delete(path);
      }
    }
    const nextProjects: HTMLElement[] = [];
    for (const entry of entries) {
      let project = this.projects.get(entry.path);
      if (!project) {
        project = this.createProject(entry.path);
        this.projects.set(entry.path, project);
      }
      const name = entry.path.split(/[\\/]/).filter(Boolean).pop() ?? UI_STRINGS.sidebar.noProject;
      project.folder.update(name, false, entry.expanded ?? true);
      attribute(project.folder.select, "title", entry.path || name);
      attribute(project.el, "data-active", String(entry.active));
      visibility(project.tree, entry.expanded ?? true);
      const nextGroups: HTMLElement[] = [];
      const retained = new Set(entry.groups.map((group) => group.id));
      for (const [id] of project.groups) if (!retained.has(id)) project.groups.delete(id);
      for (const group of entry.groups) {
        let nodes = project.groups.get(group.id);
        if (!nodes) {
          nodes = this.createGroup(entry.path, group);
          project.groups.set(group.id, nodes);
        }
        const groupActive = entry.active && entry.activeGroupId === group.id;
        nodes.row.update(group.title, groupActive, group.expanded ?? true);
        visibility(nodes.sessions, group.expanded ?? true);
        const nextSessions: HTMLElement[] = [];
        const retainedSessions = new Set(group.chatIds);
        for (const [id] of nodes.chats)
          if (!retainedSessions.has(id) || !chats.has(id)) nodes.chats.delete(id);
        for (const id of group.chatIds) {
          const chat = chats.get(id);
          if (!chat) continue;
          let row = nodes.chats.get(id);
          if (!row) {
            row = this.createSession(entry.path, group.id, chat);
            nodes.chats.set(id, row);
          }
          row.setIcon(sessionIcon(chat));
          row.update(chat.title, groupActive && chatState.activeChatId === id);
          nextSessions.push(row.el);
        }
        reconcile(nodes.sessions, nextSessions);
        nextGroups.push(nodes.el);
      }
      reconcile(project.tree, nextGroups);
      nextProjects.push(project.el);
    }
    reconcile(this.projectsEl, nextProjects);
    this.menu.closeIfDetached();
    if (hadFocus && !focused?.isConnected) {
      const active = this.projects.get(navigation.projectPath);
      const group = active?.groups.get(navigation.activeGroupId);
      (
        group?.chats.get(chatState.activeChatId)?.select ??
        group?.row.select ??
        active?.folder.select
      )?.focus();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.menu.close(false);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.projects.clear();
  }
}
