import { Cell } from "retend";

import { cancelMcpCandidate, waitForMcpCandidate } from "@/platform/desktopClient";
import type {
  DesktopMcpAuthorization,
  DesktopMcpCandidate,
  DesktopMcpConnectResponse,
} from "@/platform/desktopClient";

/** Shared candidate lifecycle for manual and curated MCP connections. */
export function useMcpCandidateFlow() {
  const candidate = Cell.source<DesktopMcpCandidate | null>(null);
  const authorization = Cell.source<DesktopMcpAuthorization | null>(null);
  const attempt = Cell.source(0);

  const clear = (cancel: boolean) => {
    const id = candidate.get()?.candidateId ?? authorization.get()?.candidateId;
    attempt.set(attempt.get() + 1);
    candidate.set(null);
    authorization.set(null);
    if (cancel && id) void cancelMcpCandidate(id).catch(() => undefined);
  };

  const wait = async (current: DesktopMcpAuthorization, token = attempt.get()) => {
    const active = () => attempt.get() === token && authorization.get() === current;
    const status = await waitForMcpCandidate(current.candidateId, active);
    if (!active()) return false;
    if (status.status !== "ready")
      throw new Error("MCP authorization did not produce a connection.");
    authorization.set(null);
    candidate.set(status.candidate);
    return true;
  };

  const accept = async (
    response: DesktopMcpConnectResponse,
    token: number,
    onAuthorize: (authorization: DesktopMcpAuthorization) => void,
  ) => {
    const id = response.status === "ready" ? response.candidate.candidateId : response.candidateId;
    if (token !== attempt.get()) {
      await cancelMcpCandidate(id);
      return false;
    }
    if (response.status === "ready") {
      candidate.set(response.candidate);
      return true;
    }
    const current = { candidateId: id, authorizationUrl: response.authorizationUrl };
    authorization.set(current);
    onAuthorize(current);
    return wait(current, token);
  };

  return { candidate, authorization, attempt, accept, wait, clear };
}
