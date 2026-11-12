import { AtomicStore } from "./atomic-store.js";

/** Persisted UI navigation only. Document text remains owned by host-core. */
export interface WorkGroup {
  readonly id: string;
  readonly title: string;
  readonly chatIds: readonly string[];
  readonly lastActiveChatId?: string | undefined;
  readonly expanded?: boolean;
}

export interface ProjectNavigationSnapshot {
  readonly groups: readonly WorkGroup[];
  readonly activeGroupId: string;
  readonly expanded?: boolean;
}

export interface WorkspaceNavigationState extends ProjectNavigationSnapshot {
  readonly projectGroups?: Readonly<Record<string, ProjectNavigationSnapshot>>;
  readonly projectPath: string;
}

export interface WorkspaceNavigationActions {
  readonly navigation: AtomicStore<WorkspaceNavigationState>;
  createWorkGroup(title: string): void;
  renameWorkGroup(id: string, title: string): void;
  setWorkGroupExpanded(id: string, expanded: boolean): void;
  setAllWorkGroupsExpanded(expanded: boolean): void;
  setProjectExpanded(expanded: boolean): void;
  selectWorkGroup(id: string): void;
  setProjectPath(path: string): void;
}

export function createWorkspaceNavigation(
  initialState: WorkspaceNavigationState | undefined,
  initialChatIds: readonly string[],
  getChatIds: () => readonly string[],
  onSelectChat: (chatId: string) => void,
): WorkspaceNavigationActions {
  const navigation = new AtomicStore<WorkspaceNavigationState>(
    initialState ?? {
      projectPath: "",
      groups: [
        {
          id: "initial-group",
          title: "Workspace",
          chatIds: initialChatIds,
        },
      ],
      activeGroupId: "initial-group",
    },
  );
  let groupSequence = 0;

  return {
    navigation,
    createWorkGroup(title: string): void {
      const trimmed = title.trim();
      if (!trimmed) return;
      let id = `group-${++groupSequence}`;
      while (navigation.getState().groups.some((group) => group.id === id))
        id = `group-${++groupSequence}`;
      navigation.setState((prev) => ({
        ...prev,
        groups: [...prev.groups, { id, title: trimmed, chatIds: [] }],
        activeGroupId: id,
      }));
    },
    renameWorkGroup(id: string, title: string): void {
      const trimmed = title.trim();
      if (
        !trimmed ||
        !navigation.getState().groups.some((group) => group.id === id && group.title !== trimmed)
      )
        return;
      navigation.setState((prev) => ({
        ...prev,
        groups: prev.groups.map((group) =>
          group.id === id ? { ...group, title: trimmed } : group,
        ),
      }));
    },
    setWorkGroupExpanded(id: string, expanded: boolean): void {
      if (
        !navigation
          .getState()
          .groups.some((group) => group.id === id && (group.expanded ?? true) !== expanded)
      )
        return;
      navigation.setState((prev) => ({
        ...prev,
        groups: prev.groups.map((group) => (group.id === id ? { ...group, expanded } : group)),
      }));
    },
    setProjectExpanded(expanded: boolean): void {
      navigation.setState((prev) =>
        (prev.expanded ?? true) === expanded ? prev : { ...prev, expanded },
      );
    },
    selectWorkGroup(id: string): void {
      const current = navigation.getState();
      const group = current.groups.find((item) => item.id === id);
      if (!group) return;
      const chatIds = new Set(getChatIds());
      const chatId = [group.lastActiveChatId, ...group.chatIds].find(
        (id) => id && group.chatIds.includes(id) && chatIds.has(id),
      );
      if (chatId) onSelectChat(chatId);
      else if (current.activeGroupId !== id)
        navigation.setState((prev) => ({ ...prev, activeGroupId: id }));
    },
    setProjectPath(projectPath: string): void {
      navigation.setState((prev) => {
        if (prev.projectPath === projectPath) return prev;
        if (!prev.projectPath) return { ...prev, projectPath };
        const projectGroups = {
          ...prev.projectGroups,
          [prev.projectPath]: {
            groups: prev.groups,
            activeGroupId: prev.activeGroupId,
            expanded: prev.expanded ?? true,
          },
        };
        const saved = projectGroups[projectPath];
        return {
          ...prev,
          projectPath,
          projectGroups,
          groups: saved?.groups ?? [{ id: "initial-group", title: "Workspace", chatIds: [] }],
          activeGroupId: saved?.activeGroupId ?? "initial-group",
          expanded: saved?.expanded ?? true,
        };
      });
    },
    setAllWorkGroupsExpanded(expanded: boolean): void {
      navigation.setState((prev) =>
        (prev.expanded ?? true) &&
        prev.groups.every((group) => (group.expanded ?? true) === expanded)
          ? prev
          : {
              ...prev,
              expanded: true,
              groups: prev.groups.map((group) => ({ ...group, expanded })),
            },
      );
    },
  };
}
