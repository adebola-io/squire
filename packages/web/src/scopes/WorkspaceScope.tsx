import { AsyncCell, Cell, createScope, useScopeContext } from "retend";
import type { JSX } from "retend/jsx-runtime";

import {
  addWorkspaceRoot,
  listWorkspaceRoots,
  removeWorkspaceRoot,
  revealWorkspaceRoot,
  setWorkspaceRootEnabled,
} from "@/platform/desktopClient";
import { errorMessage } from "@/utils/misc";

export interface WorkspaceRoot {
  path: string;
  enabled: boolean;
  exists: boolean;
}

interface WorkspaceState {
  roots: AsyncCell<WorkspaceRoot[]>;
  error: Cell<string | null>;
  busyPath: Cell<string | null>;
  addRoot: (path: string) => Promise<boolean>;
  toggleRoot: (root: WorkspaceRoot) => Promise<void>;
  removeRoot: (root: WorkspaceRoot) => Promise<void>;
  revealRoot: (root: WorkspaceRoot) => Promise<void>;
  revalidate: () => void;
  clearError: () => void;
}

interface WorkspaceStateProviderProps {
  children: JSX.Children;
}

interface WorkspaceMutation {
  action: () => Promise<unknown>;
  refresh: boolean;
}

const WorkspaceStateScope = createScope<WorkspaceState>();

export function WorkspaceStateProvider(props: WorkspaceStateProviderProps) {
  const { children } = props;
  const activePath = Cell.source<string | null>(null);
  const mutation = Cell.task(async (input: WorkspaceMutation) => {
    await input.action();
    if (input.refresh) roots.revalidate();
  });
  const roots = Cell.derivedAsync(() => {
    return listWorkspaceRoots<WorkspaceRoot[]>();
  });
  const busyPath = Cell.derived(() => (mutation.pending.get() ? activePath.get() : null));
  const error = Cell.derived(() => {
    const cause = mutation.error.get();
    return cause === null ? null : errorMessage(cause);
  });
  const revalidate = () => roots.revalidate();
  const clearError = () => mutation.error.set(null);
  const mutate = async (path: string, action: () => Promise<unknown>, refresh = true) => {
    if (mutation.pending.get()) return false;
    activePath.set(path);
    await mutation.runWith({ action, refresh });
    return mutation.error.get() === null;
  };

  const addRoot = (path: string) => mutate("add", () => addWorkspaceRoot(path));
  const toggleRoot = async (root: WorkspaceRoot) => {
    await mutate(root.path, () => setWorkspaceRootEnabled(root.path));
  };
  const removeRoot = async (root: WorkspaceRoot) => {
    await mutate(root.path, () => removeWorkspaceRoot(root.path));
  };
  const revealRoot = async (root: WorkspaceRoot) => {
    await mutate(root.path, () => revealWorkspaceRoot(root.path), false);
  };

  return (
    <WorkspaceStateScope.Provider
      value={{
        roots,
        error,
        busyPath,
        addRoot,
        toggleRoot,
        removeRoot,
        revealRoot,
        revalidate,
        clearError,
      }}
    >
      {children}
    </WorkspaceStateScope.Provider>
  );
}

export function useWorkspaceState() {
  return useScopeContext(WorkspaceStateScope);
}
