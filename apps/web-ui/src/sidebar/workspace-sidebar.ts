import type { CockpitChatTab, CockpitFileTreeNode, CockpitStoreBundle } from "../stores.js";
import type { WorkGroup } from "../workspace-navigation.js";
import { attribute, button, reconcile, visibility } from "./dom.js";
import { FOLDER_ICON, GROUP_ICON } from "./icons.js";
import { SidebarMenu } from "./sidebar-menu.js";
import { SidebarRow } from "./sidebar-row.js";

interface GroupNodes {
  readonly el: HTMLElement;
  readonly row: SidebarRow;
  readonly sessions: HTMLElement;
  readonly chats: Map<string, SidebarRow>;
}

export interface WorkspaceSidebarOptions {
  readonly controlsHost: HTMLElement;
  readonly treeHost: HTMLElement;
  readonly stores: CockpitStoreBundle;
  readonly openWorkspace?: () => Promise<readonly CockpitFileTreeNode[] | null>;
}

/** Owns sidebar navigation DOM and subscriptions, independent of the editor and streaming. */
export class WorkspaceSidebar {
  private readonly groups = new Map<string, GroupNodes>();
  private readonly folder: SidebarRow;
  private readonly tree: HTMLElement;
  private readonly openProjectButton: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly menu: SidebarMenu;
  private readonly unsubscribers: Array<() => void> = [];
  private opening = false;
  private destroyed = false;
  private projectPath: string;

  constructor(private readonly options: WorkspaceSidebarOptions) {
    const { controlsHost, treeHost, stores } = options;
    const doc = treeHost.ownerDocument;
    controlsHost.className = "sidebar-project-controls";
    treeHost.className = "sidebar-navigation";
    treeHost.setAttribute("aria-label", "Folder, groups and sessions");
    this.menu = new SidebarMenu(treeHost);
    this.projectPath = stores.navigation.getState().projectPath;
    this.openProjectButton = button(
      doc,
      "sidebar-row sidebar-open-project sidebar-open-project-label",
      "Open project",
    );
    this.openProjectButton.innerHTML = `<span class="sidebar-open-project-icon" aria-hidden="true">${FOLDER_ICON}</span><span>Open project</span>`;
    this.openProjectButton.disabled = !options.openWorkspace;
    this.openProjectButton.title = "Open a project folder";
    this.openProjectButton.addEventListener("click", () => {
      void this.openProject();
    });
    this.error = doc.createElement("p");
    this.error.className = "sidebar-error";
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    controlsHost.append(this.openProjectButton, this.error);

    this.folder = new SidebarRow(doc, {
      kind: "folder",
      onSelect: () => stores.setProjectExpanded(!(stores.navigation.getState().expanded ?? true)),
      onMore: (anchor) =>
        this.menu.open(anchor, [
          { label: "Expand all groups", run: () => this.expandAll(true) },
          { label: "Collapse all groups", run: () => this.expandAll(false) },
          {
            label: "Open project…",
            disabled: !options.openWorkspace || this.opening,
            run: () => {
              void this.openProject();
            },
          },
        ]),
    });
    this.tree = doc.createElement("div");
    this.tree.className = "sidebar-group-tree";
    treeHost.append(this.folder.el, this.tree);
    this.update();
    this.unsubscribers.push(
      stores.navigation.subscribe(() => this.update()),
      stores.zone3.subscribe((next, prev) => {
        if (next.activeChatId !== prev.activeChatId || next.chats !== prev.chats) this.update();
      }),
    );
  }

  private expandAll(expanded: boolean): void {
    this.options.stores.setAllWorkGroupsExpanded(expanded);
  }

  private async openProject(): Promise<void> {
    if (!this.options.openWorkspace || this.opening || this.destroyed) return;
    this.opening = true;
    this.openProjectButton.disabled = true;
    this.openProjectButton.setAttribute("aria-busy", "true");
    this.openProjectButton.title = "Opening…";
    this.error.hidden = true;
    try {
      const nodes = await this.options.openWorkspace();
      if (!this.destroyed && nodes) this.options.stores.setFileTree(nodes);
    } catch (error: unknown) {
      if (!this.destroyed) {
        this.error.textContent = error instanceof Error ? error.message : "Unable to open project";
        this.error.hidden = false;
      }
    } finally {
      this.opening = false;
      if (!this.destroyed) {
        this.openProjectButton.disabled = false;
        this.openProjectButton.setAttribute("aria-busy", "false");
        this.openProjectButton.title = "Open a project folder";
      }
    }
  }

  private createGroup(group: WorkGroup): GroupNodes {
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
      onSelect: () => stores.selectWorkGroup(group.id),
      onToggle: () => {
        const latest = stores.navigation.getState().groups.find((item) => item.id === group.id);
        if (latest) stores.setWorkGroupExpanded(group.id, !(latest.expanded ?? true));
      },
      onMore: (anchor) => {
        const latest = stores.navigation.getState().groups.find((item) => item.id === group.id);
        if (!latest) return;
        this.menu.open(anchor, [
          {
            label: "Rename group",
            run: () => row.rename(latest.title, (name) => stores.renameWorkGroup(group.id, name)),
          },
          {
            label: latest.expanded === false ? "Expand group" : "Collapse group",
            run: () => stores.setWorkGroupExpanded(group.id, latest.expanded === false),
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

  private createSession(groupId: string, chat: CockpitChatTab): SidebarRow {
    const { stores, treeHost } = this.options;
    const row = new SidebarRow(treeHost.ownerDocument, {
      kind: "session",
      onSelect: () => {
        // selectChat records the owning group and the selected session in one step.
        stores.selectChat(chat.chatId);
      },
      onMore: (anchor) => {
        const latest = stores.zone3.getState().chats.find((item) => item.chatId === chat.chatId);
        if (!latest) return;
        const state = stores.zone3.getState();
        this.menu.open(anchor, [
          {
            label: "Rename session",
            run: () => row.rename(latest.title, (name) => stores.renameChat(chat.chatId, name)),
          },
          {
            label: "Close session",
            disabled:
              state.chats.length <= 1 ||
              state.activeRunningAgentChatId === chat.chatId ||
              state.sequentialAgentQueue.includes(chat.chatId),
            run: () => stores.closeChat(chat.chatId),
          },
        ]);
      },
    });
    row.el.dataset.chatId = chat.chatId;
    row.el.dataset.groupId = groupId;
    row.select.dataset.chatId = chat.chatId;
    return row;
  }

  private update(): void {
    const { stores } = this.options;
    const focused = this.options.treeHost.ownerDocument.activeElement as HTMLElement | null;
    const hadFocus = focused !== null && this.options.treeHost.contains(focused);
    const navigation = stores.navigation.getState();
    const chatState = stores.zone3.getState();
    if (navigation.projectPath !== this.projectPath) {
      this.menu.close(false);
      this.groups.clear();
      this.projectPath = navigation.projectPath;
    }
    const name = navigation.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "No project open";
    this.folder.update(name, false, navigation.expanded ?? true);
    attribute(this.folder.select, "title", navigation.projectPath || name);
    visibility(this.tree, navigation.expanded ?? true);
    const chats = new Map(chatState.chats.map((chat) => [chat.chatId, chat]));
    const nextGroups: HTMLElement[] = [];
    const retained = new Set(navigation.groups.map((group) => group.id));
    for (const [id] of this.groups) if (!retained.has(id)) this.groups.delete(id);
    for (const group of navigation.groups) {
      let nodes = this.groups.get(group.id);
      if (!nodes) {
        nodes = this.createGroup(group);
        this.groups.set(group.id, nodes);
      }
      nodes.row.update(group.title, navigation.activeGroupId === group.id, group.expanded ?? true);
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
          row = this.createSession(group.id, chat);
          nodes.chats.set(id, row);
        }
        row.update(
          chat.title,
          navigation.activeGroupId === group.id && chatState.activeChatId === id,
        );
        nextSessions.push(row.el);
      }
      reconcile(nodes.sessions, nextSessions);
      nextGroups.push(nodes.el);
    }
    reconcile(this.tree, nextGroups);
    this.menu.closeIfDetached();
    if (hadFocus && !focused?.isConnected) {
      const active = this.groups.get(navigation.activeGroupId);
      (
        active?.chats.get(chatState.activeChatId)?.select ??
        active?.row.select ??
        this.folder.select
      ).focus();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.menu.close(false);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.groups.clear();
  }
}
