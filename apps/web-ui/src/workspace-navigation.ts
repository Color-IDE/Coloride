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
  /** Saved snapshots of every non-active project. The active one lives in the top-level fields. */
  readonly projectGroups?: Readonly<Record<string, ProjectNavigationSnapshot>>;
  readonly projectPath: string;
  /** Display order of every opened project (active included). Absent in legacy caches. */
  readonly projectOrder?: readonly string[];
}

export interface ProjectEntry extends ProjectNavigationSnapshot {
  readonly path: string;
  readonly active: boolean;
}

const DEFAULT_GROUPS: readonly WorkGroup[] = [
  { id: "initial-group", title: "Workspace", chatIds: [] },
];

/** Every opened project, in display order, with the active one resolved from the top-level fields. */
export function listProjects(state: WorkspaceNavigationState): readonly ProjectEntry[] {
  const order = [...(state.projectOrder ?? Object.keys(state.projectGroups ?? {}))];
  if (!order.includes(state.projectPath)) order.push(state.projectPath);
  return order.map((path) => {
    if (path === state.projectPath) {
      return {
        path,
        active: true,
        groups: state.groups,
        activeGroupId: state.activeGroupId,
        expanded: state.expanded ?? true,
      };
    }
    const saved = state.projectGroups?.[path];
    return {
      path,
      active: false,
      groups: saved?.groups ?? DEFAULT_GROUPS,
      activeGroupId: saved?.activeGroupId ?? "initial-group",
      expanded: saved?.expanded ?? true,
    };
  });
}

export interface WorkspaceNavigationActions {
  readonly navigation: AtomicStore<WorkspaceNavigationState>;
  createWorkGroup(title: string): void;
  renameWorkGroup(id: string, title: string): void;
  setWorkGroupExpanded(id: string, expanded: boolean): void;
  setAllWorkGroupsExpanded(expanded: boolean): void;
  setProjectExpanded(expanded: boolean, path?: string): void;
  removeProject(path: string): void;
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
    setProjectExpanded(expanded: boolean, path?: string): void {
      navigation.setState((prev) => {
        if (path !== undefined && path !== prev.projectPath) {
          const saved = prev.projectGroups?.[path];
          if (!saved || (saved.expanded ?? true) === expanded) return prev;
          return {
            ...prev,
            projectGroups: { ...prev.projectGroups, [path]: { ...saved, expanded } },
          };
        }
        return (prev.expanded ?? true) === expanded ? prev : { ...prev, expanded };
      });
    },
    removeProject(path: string): void {
      navigation.setState((prev) => {
        const order = listProjects(prev).map((entry) => entry.path);
        if (!order.includes(path)) return prev;
        const nextOrder = order.filter((item) => item !== path);
        const { [path]: _removed, ...others } = prev.projectGroups ?? {};
        if (path !== prev.projectPath) {
          return { ...prev, projectGroups: others, projectOrder: nextOrder };
        }
        // Removing the active project: fall back to the next one, or to an empty workspace.
        const nextPath = nextOrder[0];
        if (nextPath === undefined) {
          return {
            ...prev,
            projectPath: "",
            projectGroups: {},
            projectOrder: [],
            groups: DEFAULT_GROUPS,
            activeGroupId: "initial-group",
            expanded: true,
          };
        }
        const { [nextPath]: next, ...rest } = others;
        return {
          ...prev,
          projectPath: nextPath,
          projectGroups: rest,
          projectOrder: nextOrder,
          groups: next?.groups ?? DEFAULT_GROUPS,
          activeGroupId: next?.activeGroupId ?? "initial-group",
          expanded: next?.expanded ?? true,
        };
      });
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
        if (prev.projectPath === projectPath) {
          return projectPath && !prev.projectOrder?.includes(projectPath)
            ? { ...prev, projectOrder: [...(prev.projectOrder ?? []), projectPath] }
            : prev;
        }
        const order = listProjects(prev)
          .map((entry) => entry.path)
          .filter(Boolean);
        if (projectPath && !order.includes(projectPath)) order.push(projectPath);
        if (!prev.projectPath) {
          // First project opened: it adopts the initial (pathless) groups.
          return { ...prev, projectPath, projectOrder: order };
        }
        const saved = prev.projectGroups?.[projectPath];
        const { [projectPath]: _taken, ...others } = {
          ...prev.projectGroups,
          [prev.projectPath]: {
            groups: prev.groups,
            activeGroupId: prev.activeGroupId,
            expanded: prev.expanded ?? true,
          },
        };
        return {
          ...prev,
          projectPath,
          projectOrder: order,
          // Keep every other project's snapshot so it stays visible in the sidebar.
          projectGroups: others,
          groups: saved?.groups ?? DEFAULT_GROUPS,
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
